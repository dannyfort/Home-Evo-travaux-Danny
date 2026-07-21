/* ============================================================================
   HET GLASS ENGINE — « La Métamorphose » liquid-glass UI layer
   ----------------------------------------------------------------------------
   Origine : projet claude.design « Liquid Glass Construction Film »
   (84e4a962…, fichier glass-engine.js), porté en production avec les
   durcissements éprouvés de scrub-engine.js v7 :
     - sélection desktop/mobile des legs (src / srcMobile, choisie au mount)
     - lingerEase par leg (la caméra se pose mi-scène, remap pur du scrub)
     - garde resize mobile : les resize « barre d'URL » (largeur inchangée,
       pointeur coarse) sont ignorés — pas de saut ni de re-targets
     - priming iOS au premier touchstart en plus du pointerdown
     - watchdog rAF : si la chaîne de frames est suspendue (webview/onglet
       throttlé) on la relance au timer
     - Tier C : hauteur de scroll depuis le document (le track y est masqué)

   Modules (single file, no build step):
     ScrubFilm       — 6 blob-loaded video legs, scroll-scrubbed, seam crossfade.
                       Poster textures until each leg is seekable.
     WorldBackdrop   — full-viewport plane rendered to an offscreen target the
                       glass refracts. Grade follows the film's light arc
                       (morning → golden hour), handheld micro-drift, light
                       shafts answering the pointer, focus-mode defocus.
                       PRODUCTION SWAP: the film already IS video here, but
                       `backdrop.setVideoTexture(tex)` force-feeds a single
                       external THREE.VideoTexture onto the plane (bypasses the
                       leg system) — one call, nothing else changes.
     GlassMaterial   — ONE shared GLSL program (fresnel-weighted refraction,
                       3-tap chromatic dispersion, variable radial frost,
                       stone tint + inner stroke, sliding specular streak,
                       click pressure-ripple). Per-card uniforms only.
     GlassCard       — WebGL slab + slaved DOM element (text stays real DOM),
                       damped springs for tilt / lift / lag, idle float.
     CardChoreographer— scroll timeline: scene ranges, entrance (rise+settle,
                       frost resolve), exit (drift toward camera + dissolve),
                       depth parallax lag.
     Pointer         — shared pointer springs, magnetic buttons ([data-magnetic]).
     PerfGovernor    — adaptive DPR (cap 1.5), fps watchdog, tier fallback,
                       rAF paused when tab hidden, full dispose().
   Tiers: A = full WebGL pipeline · C = no WebGL / prefers-reduced-motion →
          DOM poster backdrop + CSS frosted cards, no motion.
   ========================================================================== */
(function () {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  // eased overshoot for entrances (scrub-safe pure function, ~1.5% overshoot)
  const settle = (t) => { t = clamp(t, 0, 1); const s = 1.70158 * 0.55; const u = t - 1; return 1 + (u * u * ((s + 1) * u + s)) * (1 - t * 0.2) * -(-1); };
  // smooth fluid entrances (no overshoot/pop)
  const easeOutCubic = (t) => { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); };
  const easeOutBack = (t) => { t = clamp(t, 0, 1); const c1 = 1.45, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  // Per-leg dwell (porté de scrub-engine v7) : remap monotone scroll→temps pour
  // que la caméra se pose mi-scène et accélère aux coutures. f(0)=0, f(1)=1 —
  // les frames de handoff ne bougent jamais.
  const lingerEase = (x, L) => { L = clamp(L, 0, 1); const c = x - 0.5; return (1 - L) * x + L * (4 * c * c * c + 0.5); };

  /* ---------------- damped spring ---------------- */
  class Spring {
    constructor(v, stiffness, damping) { this.v = v; this.t = v; this.vel = 0; this.k = stiffness; this.d = damping; }
    step(dt) {
      dt = Math.min(dt, 1 / 30);
      const a = -this.k * (this.v - this.t) - this.d * this.vel;
      this.vel += a * dt; this.v += this.vel * dt;
      return this.v;
    }
    snap(v) { this.v = this.t = v; this.vel = 0; }
  }

  /* ================= SHADERS ================= */

  const BACKDROP_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

  // LE FILM EST INTOUCHABLE (règle « ne casse rien vs v7 ») : aucun re-grade,
  // pas de vignette, pas de rais de lumière, pas de faux handheld, pas de zoom —
  // les pixels des clips upscalés sont rendus tels quels, comme le <video> de
  // scrub-engine v7. Seuls restent : le cover-fit, le crossfade de couture,
  // l'assombrissement transitoire du focus-mode et le fondu de chargement.
  const BACKDROP_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D texA, texB;
  uniform float uMix, uAspA, uAspB, uScreenAsp;
  uniform float uFocus;
  uniform float uFadeIn;

  vec2 coverUv(vec2 uv, float va){
    vec2 s = (uScreenAsp > va) ? vec2(1.0, va / uScreenAsp) : vec2(uScreenAsp / va, 1.0);
    return (uv - 0.5) * s + 0.5;
  }
  void main(){
    vec3 a = texture2D(texA, coverUv(vUv, uAspA)).rgb;
    vec3 b = texture2D(texB, coverUv(vUv, uAspB)).rgb;
    vec3 c = mix(a, b, uMix);

    // focus-mode dim (interaction formulaire, transitoire)
    c *= (1.0 - uFocus * 0.16);

    // load fade from stone
    c = mix(vec3(0.949, 0.937, 0.914), c, uFadeIn);
    gl_FragColor = vec4(c, 1.0);
  }`;

  const BLUR_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tex; uniform vec2 uDir;
  void main(){
    vec3 c = texture2D(tex, vUv).rgb * 0.227;
    c += texture2D(tex, vUv + uDir * 1.384).rgb * 0.316;
    c += texture2D(tex, vUv - uDir * 1.384).rgb * 0.316;
    c += texture2D(tex, vUv + uDir * 3.230).rgb * 0.0703;
    c += texture2D(tex, vUv - uDir * 3.230).rgb * 0.0703;
    gl_FragColor = vec4(c, 1.0);
  }`;

  // Pas de grain : le film sort à l'écran pixel pour pixel (le défocus n'est
  // mélangé que pendant le focus-mode du formulaire).
  const COPY_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tex, texBlur; uniform float uFocus;
  void main(){
    vec3 c = mix(texture2D(tex, vUv).rgb, texture2D(texBlur, vUv).rgb, uFocus * 0.55);
    gl_FragColor = vec4(c, 1.0);
  }`;

  const GLASS_VERT = `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

  const GLASS_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexSharp, uTexBlur;
  uniform vec2 uRes, uSize, uTilt, uSunDir;
  uniform float uRadius, uHover, uEnter, uExit, uFrost, uRefr, uTime;
  uniform float uSunWarm, uStreak, uBreathe, uQuality;
  uniform vec4 uRipple; /* x,y: local px from centre · z: age s · w: amp */

  float sdRB(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }

  void main(){
    vec2 p = (vUv - 0.5) * uSize;              // local px, y up
    vec2 b = uSize * 0.5 - 1.0;
    float d = sdRB(p, b, uRadius);
    float shape = 1.0 - smoothstep(-1.2, 0.4, d);
    if (shape <= 0.004) discard;

    // sdf gradient -> 2D edge normal
    float e = 1.5;
    vec2 n2 = vec2(
      sdRB(p + vec2(e, 0.0), b, uRadius) - sdRB(p - vec2(e, 0.0), b, uRadius),
      sdRB(p + vec2(0.0, e), b, uRadius) - sdRB(p - vec2(0.0, e), b, uRadius));
    n2 = normalize(n2 + 1e-5);

    // lens rim: bevel band along the edge, fresnel-weighted
    float edgeW = min(min(uSize.x, uSize.y) * 0.42, 34.0);
    float bev = pow(smoothstep(-edgeW, 0.0, d), 1.7);
    float fres = bev;
    vec3 N = normalize(vec3(n2 * bev * 1.5, 1.0));

    // click pressure-ripple through the slab
    float rAmp = uRipple.w * exp(-uRipple.z * 2.4);
    if (rAmp > 0.002) {
      float rd = length(p - uRipple.xy);
      float wave = sin(rd * 0.085 - uRipple.z * 15.0) * exp(-rd * 0.006) * rAmp;
      N.xy += normalize(p - uRipple.xy + 1e-4) * wave;
    }
    N.xy += uTilt * 0.9;
    N = normalize(N);

    // refraction: fresnel-weighted UV offset into the backdrop target
    float refr = uRefr * (1.0 + uHover * 0.2) * (10.0 + 30.0 * fres);
    vec2 suv = gl_FragCoord.xy / uRes;
    vec2 off = -N.xy * refr / uRes.y;

    // chromatic dispersion, 3 taps, edges only (dropped below quality 0.5)
    vec3 sharp;
    if (uQuality > 0.5) {
      vec2 dv = n2 * (fres * 2.4 / uRes.y);
      sharp.r = texture2D(uTexSharp, suv + off + dv).r;
      sharp.g = texture2D(uTexSharp, suv + off).g;
      sharp.b = texture2D(uTexSharp, suv + off - dv).b;
    } else {
      sharp = texture2D(uTexSharp, suv + off).rgb;
    }
    vec3 blurc = texture2D(uTexBlur, suv + off * 0.7).rgb;

    // variable frost: frosted centre (legibility), clear lens-y rim.
    // entrance: resolves from heavy blur to spec'd frost.
    float frost = uFrost * (1.0 - bev * 0.8);
    frost = mix(1.0, frost, smoothstep(0.15, 1.0, uEnter));
    vec3 col = mix(sharp, blurc, clamp(frost, 0.0, 1.0));

    // carte blanche : corps blanc porcelaine, centre laiteux, lentille claire
    // au bord (l'esthétique pierre/sable v7 est remplacée — décision 21/07)
    vec3 stone = vec3(0.988, 0.986, 0.980);
    col = mix(col, stone, 0.40 + 0.07 * fres + uHover * 0.02 + uBreathe * 0.05);
    col += stone * (1.0 - bev) * 0.10;

    // 1px inner stroke (filet blanc)
    float ring = 1.0 - smoothstep(0.0, 1.8, abs(d + 2.2));
    col = mix(col, vec3(1.0), ring * 0.5);

    // specular: global sun + streak that slides with pointer/tilt along top bevel
    vec3 L = normalize(vec3(uSunDir, 0.6));
    float spec = pow(max(dot(N, L), 0.0), 26.0) * fres;
    float topEdge = smoothstep(b.y - edgeW * 1.1, b.y - 1.0, p.y);
    float sx = vUv.x - uStreak;
    float streak = exp(-sx * sx * 14.0) * topEdge;
    vec3 sunCol = mix(vec3(1.0, 1.0, 1.0), vec3(1.0, 0.92, 0.78), uSunWarm);
    col += sunCol * (spec * 0.38 + streak * (0.16 + uHover * 0.22));

    // exit: dissolve as we fly past
    float alpha = shape * smoothstep(0.0, 0.55, uEnter) * (1.0 - uExit);
    gl_FragColor = vec4(col, alpha * 0.96);
  }`;

  const DUST_VERT = `
  attribute float aSize, aPhase;
  uniform float uTime;
  varying float vA;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize;
    vA = 0.5 + 0.5 * sin(uTime * 0.23 + aPhase * 3.1);
  }`;
  const DUST_FRAG = `
  precision highp float;
  varying float vA;
  uniform float uWarm;
  void main(){
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.05, d) * vA * 0.28;
    vec3 c = mix(vec3(1.0), vec3(1.0, 0.93, 0.8), uWarm);
    gl_FragColor = vec4(c, a);
  }`;

  /* ================= ENGINE ================= */

  function mount(cfg) {
    const THREE = window.THREE;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Phone detection (convention scrub-engine) : coarse capturé une fois,
    // la media query relue à la volée.
    const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    const smallMQ = window.matchMedia('(max-width: 860px)');
    const isMobile = () => coarse || smallMQ.matches;
    let gl = null;
    try {
      const t = document.createElement('canvas');
      gl = t.getContext('webgl2') || t.getContext('webgl');
    } catch (e) { }
    const tierC = reduce || !gl || !THREE || cfg.forceTierC;

    const state = {
      p: 0, scene: 0, time: 0, focus: 0, focusT: 0,
      pointer: { x: 0.5, y: 0.5, px: 0, py: 0 },
      lastInteract: performance.now(), destroyed: false,
      // DPR natif (cap 2) : la v7 affichait le <video> à la résolution du
      // compositeur — brider à 1.5 rendait le film flou sur Retina. Le
      // PerfGovernor redescend tout seul si la machine ne suit pas.
      quality: 1, dpr: Math.min(window.devicePixelRatio || 1, 2),
      vw: window.innerWidth, vh: window.innerHeight, fadeIn: 0,
    };

    /* ---------- scroll track ---------- */
    const track = cfg.track;
    track.style.height = (cfg.scrollVh || 1000) + 'vh';
    const scrollMax = () => Math.max(1, track.offsetHeight - state.vh);
    // Tier C masque le track (display:none → offsetHeight 0) : la hauteur de
    // scroll y vient du document lui-même.
    const docScrollMax = () => {
      const se = document.scrollingElement || document.documentElement;
      return Math.max(1, se.scrollHeight - window.innerHeight);
    };

    /* ---------- Tier C: static poster + CSS glass ---------- */
    if (tierC) {
      mountTierC(cfg, state, docScrollMax);
      return { setFocus() { }, ripple() { }, dispose() { }, tier: 'C', scrollToP: makeScrollToP(docScrollMax), registerCard() { return null; }, remeasure() { }, setVideoTexture() { } };
    }

    /* ---------- renderer ---------- */
    const canvas = cfg.canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(state.dpr);
    // updateStyle=false : le CSS (inset:0; 100vw/100vh) garde la main sur la
    // taille d'affichage — indispensable pour ignorer les resize barre d'URL.
    renderer.setSize(state.vw, state.vh, false);
    renderer.autoClear = false;

    /* ---------- ScrubFilm: legs ---------- */
    const loader = new THREE.TextureLoader();
    const legs = cfg.legs.map((L) => {
      const poster = loader.load(L.poster);
      poster.minFilter = THREE.LinearFilter; poster.generateMipmaps = false;
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.preload = 'auto'; video.crossOrigin = 'anonymous';
      const leg = { ...L, video, poster, tex: poster, ready: false, cur: 0, target: 0, asp: 16 / 9 };
      // Encodage mobile 720p réservé aux VRAIS écrans tactiles (pointeur
      // coarse). Une fenêtre desktop étroite reste en 1080p : les masters
      // upscalés ne doivent jamais être remplacés par les -m sur un Mac.
      const url = (coarse && L.srcMobile) ? L.srcMobile : L.src;
      fetch(url).then(r => r.ok ? r.blob() : Promise.reject(0)).then(blob => {
        if (state.destroyed) return;
        video.src = URL.createObjectURL(blob);
        video.addEventListener('loadeddata', () => {
          if (state.destroyed) return;
          leg.asp = (video.videoWidth / video.videoHeight) || 16 / 9;
          const vt = new THREE.VideoTexture(video);
          vt.minFilter = THREE.LinearFilter; vt.generateMipmaps = false;
          leg.tex = vt; leg.ready = true;
          try { video.currentTime = 0.001; } catch (e) { }
        }, { once: true });
        video.load();
      }).catch(() => { });
      return leg;
    });
    // leg i covers p ∈ [bounds[i], bounds[i+1]] — bascule SÈCHE aux coutures.
    // XF = 0 (décision réalisateur 17/07) : les legs sont masterisés last frame
    // = first frame au pixel près (morph optique en queue de leg), donc tout
    // fondu moteur ne peut QUE dégrader — pendant la fenêtre de fondu, A joue
    // encore sa fin (mouvement) sur B figé à sa frame 0 → double exposition.
    const bounds = cfg.legBounds;
    const XF = 0;
    let externalVideoTex = null; // setVideoTexture() production swap

    /* ---------- matchmove : tracks caméra solvés offline ----------
       tools/track_legs.py (LK + RANSAC, façon point-tracker AE/Resolve) écrit
       assets/tracks-v7.json : par leg, par ancre, position vidéo normalisée +
       échelle relative à la frame de seed, pour CHAQUE frame. Les cartes
       taguées def.track sont rivetées à ces points-monde : elles suivent
       exactement la caméra et le mur/élément qu'elles annotent. */
    let tracks = null;
    if (cfg.tracksUrl) {
      fetch(cfg.tracksUrl).then(r => (r.ok ? r.json() : null)).then(j => { tracks = j; }).catch(() => { });
    }
    // Échantillonne l'ancre à la frame réellement AFFICHÉE (leg.cur — la cible
    // du seek lerp, donc les pixels à l'écran), puis inverse le cover-fit du
    // shader backdrop pour retomber en pixels écran. Passé la couture, on
    // continue sur le prolongement `ext` dans le leg suivant (masters
    // pixel-locked : la trajectoire est continue).
    function sampleTrack(tr) {
      if (!tracks || !tracks.legs) return null;
      const L = tracks.legs[tr.leg];
      const A = L && L.anchors && L.anchors[tr.name];
      if (!A) return null;
      const dl = (state.displayLeg == null) ? legIndex(state.p) : state.displayLeg;
      let arr = A, g = legs[tr.leg];
      if (dl > tr.leg && A.ext && legs[tr.leg + 1]) { arr = A.ext; g = legs[tr.leg + 1]; }
      const cur = clamp(g.cur, 0, 1);
      const n = arr.x.length;
      const u = cur * (n - 1);
      const i0 = Math.floor(u), i1 = Math.min(n - 1, i0 + 1), ft = u - i0;
      const nx = lerp(arr.x[i0], arr.x[i1], ft);
      const ny = lerp(arr.y[i0], arr.y[i1], ft);
      const s = lerp(arr.s[i0], arr.s[i1], ft);
      const va = (g && g.ready) ? g.asp : 16 / 9, sa = state.vw / state.vh;
      const cx = sa > va ? 1 : sa / va;
      const cy = sa > va ? va / sa : 1;
      return {
        x: ((nx - 0.5) / cx + 0.5) * state.vw,
        y: ((ny - 0.5) / cy + 0.5) * state.vh,
        s: s,
      };
    }

    function legIndex(p) {
      for (let i = legs.length - 1; i >= 0; i--) if (p >= bounds[i]) return i;
      return 0;
    }
    function seekTick() {
      for (let i = 0; i < legs.length; i++) {
        const g = legs[i];
        if (!g.ready) continue;
        // Never queue a seek while the decoder is still resolving the last one
        // (un flick rapide empilerait les seeks et gèlerait le clip).
        if (g.video.seeking) continue;
        if (Math.abs(g.cur - g.target) < 0.0015 && Math.abs(g.video.currentTime - g.cur * (g.video.duration || 1)) < 0.02) continue;
        // 0.32 (vs 0.2 design) : convergence plus rapide vers la frame cible —
        // aux coutures, la frame de fin de leg est atteinte avant le fondu.
        g.cur += (g.target - g.cur) * 0.32;
        const dur = g.video.duration || 1;
        const t = clamp(g.cur, 0, 0.998) * dur;
        if (Math.abs(g.video.currentTime - t) > 0.008) { try { g.video.currentTime = t; } catch (e) { } }
      }
    }
    // iOS/Chrome: prime videos on first gesture so first seek paints
    function prime() {
      legs.forEach(g => {
        if (!g.ready) return;
        try { const pr = g.video.play(); if (pr && pr.then) pr.then(() => { try { g.video.pause(); } catch (e) { } }).catch(() => { }); } catch (e) { }
      });
    }
    window.addEventListener('pointerdown', prime, { once: true, passive: true });
    window.addEventListener('touchstart', prime, { once: true, passive: true });

    /* ---------- render targets ---------- */
    const rtOpts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false };
    let rtSharp, rtA, rtB;
    function makeTargets() {
      if (rtSharp) { rtSharp.dispose(); rtA.dispose(); rtB.dispose(); }
      // rtSharp PLEINE résolution : c'est le film à l'écran (la demi-res du
      // design rendait la vidéo floue — inacceptable vs le <video> natif de
      // v7). Seules les cibles de blur (frost/défocus) restent au quart.
      const w = Math.max(1, Math.floor(state.vw * state.dpr)), h = Math.max(1, Math.floor(state.vh * state.dpr));
      rtSharp = new THREE.WebGLRenderTarget(w, h, rtOpts);
      rtA = new THREE.WebGLRenderTarget(w >> 2, h >> 2, rtOpts);
      rtB = new THREE.WebGLRenderTarget(w >> 2, h >> 2, rtOpts);
    }
    makeTargets();

    /* ---------- WorldBackdrop ---------- */
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const backdropMat = new THREE.ShaderMaterial({
      vertexShader: BACKDROP_VERT, fragmentShader: BACKDROP_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        texA: { value: legs[0].tex }, texB: { value: legs[0].tex },
        uMix: { value: 0 }, uAspA: { value: 16 / 9 }, uAspB: { value: 16 / 9 }, uScreenAsp: { value: state.vw / state.vh },
        uFocus: { value: 0 },
        uFadeIn: { value: 0 },
      },
    });
    const backdropScene = new THREE.Scene();
    backdropScene.add(new THREE.Mesh(quadGeo, backdropMat));

    const blurMat = new THREE.ShaderMaterial({
      vertexShader: BACKDROP_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tex: { value: null }, uDir: { value: new THREE.Vector2() } },
    });
    const blurScene = new THREE.Scene();
    blurScene.add(new THREE.Mesh(quadGeo, blurMat));

    const copyMat = new THREE.ShaderMaterial({
      vertexShader: BACKDROP_VERT, fragmentShader: COPY_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tex: { value: null }, texBlur: { value: null }, uFocus: { value: 0 } },
    });
    const copyScene = new THREE.Scene();
    copyScene.add(new THREE.Mesh(quadGeo, copyMat));

    /* ---------- glass scene + pixel-true perspective camera ---------- */
    const FOV = 26;
    const glassScene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(FOV, state.vw / state.vh, 10, 20000);
    function fitCamera() {
      cam.aspect = state.vw / state.vh;
      cam.position.set(0, 0, (state.vh / 2) / Math.tan((FOV / 2) * Math.PI / 180));
      cam.updateProjectionMatrix();
      if (cfg.perspectiveLayer) cfg.perspectiveLayer.style.perspective = cam.position.z + 'px';
    }
    fitCamera();

    /* ---------- front dust (between camera and glass) ---------- */
    const dustN = 96;
    const dpos = new Float32Array(dustN * 3), dsize = new Float32Array(dustN), dph = new Float32Array(dustN);
    const dvel = new Float32Array(dustN * 2); // CPU sim: gravitational pointer + scroll airflow
    let dustPX = null, dustPY = null;
    for (let i = 0; i < dustN; i++) {
      dpos[i * 3] = (Math.random() - 0.5) * state.vw * 1.1;
      dpos[i * 3 + 1] = (Math.random() - 0.5) * state.vh * 1.1;
      dpos[i * 3 + 2] = Math.random() * 300 + 60; // in front of z=0 cards
      dsize[i] = (Math.random() * 4 + 1.5) * state.dpr;
      dph[i] = Math.random() * Math.PI * 2;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
    dustGeo.setAttribute('aSize', new THREE.BufferAttribute(dsize, 1));
    dustGeo.setAttribute('aPhase', new THREE.BufferAttribute(dph, 1));
    const dustMat = new THREE.ShaderMaterial({
      vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uScroll: { value: 0 }, uWarm: { value: 0 } },
    });
    const dust = new THREE.Points(dustGeo, dustMat);
    dust.renderOrder = 50;
    glassScene.add(dust);

    /* ---------- GlassMaterial: one program, cloned uniforms per card ---------- */
    const glassProto = new THREE.ShaderMaterial({
      vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        uTexSharp: { value: null }, uTexBlur: { value: null },
        uRes: { value: new THREE.Vector2() }, uSize: { value: new THREE.Vector2(100, 100) },
        uTilt: { value: new THREE.Vector2() }, uSunDir: { value: new THREE.Vector2(-0.5, 0.8) },
        uRadius: { value: 24 }, uHover: { value: 0 }, uEnter: { value: 0 }, uExit: { value: 0 },
        uFrost: { value: 0.55 }, uRefr: { value: 1 }, uTime: { value: 0 },
        uSunWarm: { value: 0 }, uStreak: { value: 0.3 }, uBreathe: { value: 0 },
        uQuality: { value: 1 }, uRipple: { value: new THREE.Vector4(0, 0, 99, 0) },
      },
    });
    const unitGeo = new THREE.PlaneGeometry(1, 1);

    /* ---------- GlassCard ---------- */
    const cards = [];
    class GlassCard {
      constructor(def) {
        Object.assign(this, def);
        this.el = def.el;
        this.w = 100; this.h = 100;
        this.sx = new Spring(0, 90, 16);   // lag-spring position (depth-scaled)
        this.sy = new Spring(0, 90, 16);
        this.tiltX = new Spring(0, 120, 14);
        this.tiltY = new Spring(0, 120, 14);
        this.lift = new Spring(0, 140, 16);
        this.hoverU = new Spring(0, 60, 12);
        this.phase = Math.random() * Math.PI * 2;
        this.hovered = false;
        this.breathe = 0; this.breatheT = -10;
        this.rippleStart = -10; this.rippleAmp = 0; this.rippleXY = [0, 0];
        this.visible = false;
        if (def.glass !== false) {
          this.mat = glassProto.clone();
          this.mat.uniforms.uRadius.value = def.radius != null ? def.radius : 24;
          this.mat.uniforms.uFrost.value = def.frost != null ? def.frost : 0.55;
          this.mat.uniforms.uRefr.value = def.refr != null ? def.refr : 1;
          this.mesh = new THREE.Mesh(unitGeo, this.mat);
          this.mesh.renderOrder = 10 + (def.depth || 1);
          this.mesh.visible = false;
          glassScene.add(this.mesh);
        }
        // deeper cards lag more — sauf matchmove : une carte rivetée à un mur
        // ne doit pas glisser derrière la caméra au scrub (ressort quasi-snap)
        const stiff = def.track ? 420 : 60 + (def.depth || 1) * 55;
        this.sx.k = stiff; this.sy.k = stiff;
        this.sx.d = Math.sqrt(stiff) * 1.9; this.sy.d = Math.sqrt(stiff) * 1.9;

        // connecteur matchmove : pastille sur le point-monde + filet vers la
        // carte (c'est ce qui rend le tracking lisible, façon annotation AE)
        if (def.track && def.track.connector !== false) {
          this.dotEl = document.createElement('div');
          this.dotEl.style.cssText = 'position:fixed;left:0;top:0;width:9px;height:9px;margin:-5.5px 0 0 -5.5px;border-radius:999px;border:2px solid rgba(255,255,255,0.95);background:rgba(255,255,255,0.30);box-shadow:0 0 12px rgba(255,255,255,0.8),0 1px 6px rgba(38,32,24,0.35);pointer-events:none;visibility:hidden;will-change:transform,opacity;';
          this.lineEl = document.createElement('div');
          this.lineEl.style.cssText = 'position:fixed;left:0;top:0;height:1.5px;background:linear-gradient(90deg,rgba(255,255,255,0.92),rgba(255,255,255,0.16));transform-origin:0 50%;pointer-events:none;visibility:hidden;will-change:transform,opacity,width;';
          this.el.parentNode.insertBefore(this.lineEl, this.el);
          this.el.parentNode.insertBefore(this.dotEl, this.el);
        }

        // pointer behaviour
        this.el.addEventListener('pointerenter', () => { this.hovered = true; state.lastInteract = performance.now(); });
        this.el.addEventListener('pointerleave', () => { this.hovered = false; this.tiltX.t = 0; this.tiltY.t = 0; });
        this.el.addEventListener('pointermove', (e) => {
          const r = this.el.getBoundingClientRect();
          const nx = clamp((e.clientX - r.left) / r.width, 0, 1) - 0.5;
          const ny = clamp((e.clientY - r.top) / r.height, 0, 1) - 0.5;
          const mx = (def.tiltMax != null ? def.tiltMax : 6) * Math.PI / 180;
          this.tiltY.t = -nx * mx * 2;   // face the pointer
          this.tiltX.t = ny * mx * 2;
        });
        this.el.addEventListener('pointerdown', (e) => {
          const r = this.el.getBoundingClientRect();
          this.rippleXY = [(e.clientX - r.left) - r.width / 2, -((e.clientY - r.top) - r.height / 2)];
          this.rippleStart = state.time; this.rippleAmp = 1;
          this.pressT = state.time;
        });
        this.measure();
      }
      measure() {
        this.w = this.el.offsetWidth || 100;
        this.h = this.el.offsetHeight || 100;
      }
      setVisible(v) {
        if (v === this.visible) return;
        this.visible = v;
        this.el.style.visibility = v ? 'visible' : 'hidden';
        this.el.style.pointerEvents = v ? 'auto' : 'none';
        if (this.mesh) this.mesh.visible = v;
        if (!v && this.dotEl) { this.dotEl.style.visibility = 'hidden'; this.lineEl.style.visibility = 'hidden'; }
        if (!v) { this.hovered = false; this.tiltX.snap(0); this.tiltY.snap(0); this.hoverU.snap(0); }
      }
      update(dt, frame) {
        // choreography inputs computed by choreographer -> this.cho = {x,y,enter,exit,visible,extraScale}
        const c = this.cho;
        this.setVisible(!!(c && c.visible));
        if (!this.visible) return;

        // load sequence: first-second entrance with its own settle (devis last)
        const loadE = easeOutCubic(clamp((state.time - (this.loadDelay || 0)) / 1.1, 0, 1));
        if (loadE < 1) c.enter = Math.min(c.enter, loadE);
        // 3D pivot-in: full 360° turn on load, easing out into the organic float
        let spinR = 0, spinS = 1;
        if (this.spinIn) {
          const st = clamp((state.time - (this.loadDelay || 0)) / 2.1, 0, 1);
          if (st < 1) {
            const se = 1 - Math.pow(1 - st, 3.2);
            spinR = (1 - se) * Math.PI * 2;
            spinS = 0.72 + 0.28 * se;
          }
        }

        // idle float
        const floatAmp = (this.float != null ? this.float : 1) * (1 - frame.reduceMotion);
        const fy = Math.sin(state.time * 0.55 + this.phase) * 4 * floatAmp;
        const frz = Math.sin(state.time * 0.4 + this.phase * 1.3) * 0.004 * floatAmp;

        // hover
        this.hoverU.t = this.hovered ? 1 : 0;
        const hov = clamp(this.hoverU.step(dt), 0, 1.2);
        this.lift.t = this.hovered ? -8 : 0;
        const lift = this.lift.step(dt);

        // lag spring toward target position
        this.sx.t = c.x; this.sy.t = c.y + fy + lift + c.dy;
        if (c.snap) { this.sx.snap(this.sx.t); this.sy.snap(this.sy.t); c.snap = false; }
        const X = this.sx.step(dt), Y = this.sy.step(dt);

        const rx = this.tiltX.step(dt), ry = this.tiltY.step(dt) + (c.exTilt || 0) * 0.3;
        const frzTotal = frz + (c.exTilt || 0) * 0.09;
        const press = (this.pressT != null && state.time - this.pressT < 0.18) ? 0.985 : 1;
        const focusBoost = this.focusable ? 1 + state.focus * 0.03 : 1; // glide toward camera while typing
        const scl = (c.scale != null ? c.scale : 1) * press * focusBoost * spinS;
        const sq = c.squash || 0;              // birth squash: stretches, rebounds, settles
        const sclX = scl * (1 - sq * 0.6), sclY = scl * (1 + sq);

        // breathe attract (once per idle)
        const idle = (performance.now() - state.lastInteract) / 1000;
        if (idle > 4 && state.time - this.breatheT > 12 && c.active) { this.breatheT = state.time; }
        const bt = state.time - this.breatheT;
        this.breathe = (bt > 0 && bt < 2.4) ? Math.sin((bt / 2.4) * Math.PI) : 0;

        // DOM transform (text layer). CSS y is down.
        const deg = 180 / Math.PI;
        this.el.style.transform =
          `translate3d(${X.toFixed(2)}px, ${Y.toFixed(2)}px, 0) ` +
          `rotateX(${(rx * deg).toFixed(3)}deg) rotateY(${((ry + spinR) * deg).toFixed(3)}deg) ` +
          `scale(${sclX.toFixed(4)}, ${sclY.toFixed(4)}) rotate(${(frzTotal * deg).toFixed(3)}deg)`;
        this.el.style.opacity = String(clamp(smooth(0.25, 0.9, c.enter) * (1 - (c.exitFade != null ? c.exitFade : c.exit)), 0, 1));
        const entBlur = (1 - smooth(0, 0.75, c.enter)) * 6;
        this.el.style.filter = entBlur > 0.2 ? `blur(${entBlur.toFixed(1)}px)` : '';

        // connecteur matchmove : pastille sur le point-monde, filet jusqu'au
        // bord de la carte (intersection segment centre→point / rectangle)
        if (this.dotEl) {
          const a = c.anchorPx;
          const inView = a && a[0] > -30 && a[0] < state.vw + 30 && a[1] > -30 && a[1] < state.vh + 30;
          if (a && inView && c.enter > 0.12) {
            const cx = X + this.w / 2, cy = Y + this.h / 2;
            const dx = cx - a[0], dy = cy - a[1];
            const hw = this.w / 2 * sclX, hh = this.h / 2 * sclY;
            const tEdge = Math.min(Math.abs(dx) > 1e-3 ? hw / Math.abs(dx) : 1, Math.abs(dy) > 1e-3 ? hh / Math.abs(dy) : 1, 1);
            const ex2 = cx - dx * tEdge, ey2 = cy - dy * tEdge;
            const len = Math.hypot(ex2 - a[0], ey2 - a[1]);
            const alpha = clamp(smooth(0.12, 0.7, c.enter) * (1 - (c.exitFade != null ? c.exitFade : c.exit)), 0, 1) * (0.75 + hov * 0.25);
            this.dotEl.style.visibility = 'visible';
            this.dotEl.style.opacity = String(alpha);
            this.dotEl.style.transform = `translate3d(${a[0].toFixed(1)}px, ${a[1].toFixed(1)}px, 0)`;
            if (len > 26) {
              const ang = Math.atan2(ey2 - a[1], ex2 - a[0]);
              this.lineEl.style.visibility = 'visible';
              this.lineEl.style.opacity = String(alpha * 0.9);
              this.lineEl.style.width = len.toFixed(1) + 'px';
              this.lineEl.style.transform = `translate3d(${a[0].toFixed(1)}px, ${a[1].toFixed(1)}px, 0) rotate(${ang.toFixed(4)}rad)`;
            } else this.lineEl.style.visibility = 'hidden';
          } else {
            this.dotEl.style.visibility = 'hidden';
            this.lineEl.style.visibility = 'hidden';
          }
        }

        // mesh sync
        if (this.mesh) {
          const mx = X + this.w / 2 - state.vw / 2;
          const my = -(Y + this.h / 2 - state.vh / 2);
          this.mesh.position.set(mx, my, c.z || 0);
          this.mesh.rotation.set(-rx, ry + spinR, frzTotal);
          this.mesh.scale.set(this.w * sclX, this.h * sclY, 1);
          const u = this.mat.uniforms;
          u.uSize.value.set(this.w, this.h);
          u.uHover.value = hov;
          u.uEnter.value = c.enter;
          u.uExit.value = (c.exitFade != null ? c.exitFade : c.exit);
          u.uBreathe.value = this.breathe;
          u.uTilt.value.set(ry, rx);
          const age = state.time - this.rippleStart;
          u.uRipple.value.set(this.rippleXY[0], this.rippleXY[1], age, this.rippleAmp);
          // shared per-frame
          u.uTexSharp.value = rtSharp.texture; u.uTexBlur.value = rtB.texture;
          u.uRes.value.set(state.vw * state.dpr, state.vh * state.dpr);
          u.uTime.value = state.time;
          u.uSunDir.value.copy(frame.sunDir); u.uSunWarm.value = frame.sunWarm;
          u.uStreak.value = 0.25 + state.pointer.x * 0.5 + ry * 2.0;
          u.uQuality.value = state.quality;
        }
      }
      dispose() {
        if (this.mesh) { glassScene.remove(this.mesh); this.mat.dispose(); }
        if (this.dotEl) { this.dotEl.remove(); this.lineEl.remove(); }
      }
    }

    /* ---------- CardChoreographer ---------- */
    // def.ranges: [[p0,p1],...] · def.anchor(vw,vh,phaseIndex) -> [x,y]
    // enterW/exitW: fraction of range used for entrance / exit ramps
    function choreograph(card, p) {
      const R = card.ranges;
      let vis = false, local = 0, ri = 0;
      for (let i = 0; i < R.length; i++) {
        if (p >= R[i][0] && p <= R[i][1]) { vis = true; local = (p - R[i][0]) / (R[i][1] - R[i][0]); ri = i; break; }
      }
      if (!vis) { card.cho = { visible: false }; return; }
      const eW = card.enterW != null ? card.enterW : 0.22;
      const xW = card.exitW != null ? card.exitW : 0.14;
      const first = (ri === 0 && R[0][0] === 0);
      const enterRaw = first ? 1 : clamp(local / eW, 0, 1);
      const enter = first ? 1 : easeOutCubic(enterRaw);
      const exit = clamp((local - (1 - xW)) / xW, 0, 1);
      const [ax, ay] = card.anchor(state.vw, state.vh, ri, p);

      // MATCHMOVE : la carte est rivetée au point-monde solvé (mur, verrière,
      // devanture…) — position, échelle et parallaxe viennent du track caméra,
      // pas du point de fuite synthétique. anchor() ne sert plus que de cible
      // de blend (mobile) et de repli tant que le JSON n'est pas chargé.
      if (card.track) {
        const trs = sampleTrack(card.track);
        if (trs) {
          const w = card.w || 100, h = card.h || 100;
          const t = card.track;
          const sTrk = clamp(Math.pow(Math.max(trs.s, 1e-3), t.sPow != null ? t.sPow : 0.6),
            t.sMin != null ? t.sMin : 0.62, t.sMax != null ? t.sMax : 1.35);
          const om = clamp(state.vw / 1600, 0.7, 1.3) * (0.6 + 0.4 * sTrk);
          const off = t.off || [0, 0];
          let cxp = trs.x + off[0] * om, cyp = trs.y + off[1] * om;
          const blend = t.blend != null ? t.blend : 1;
          if (blend < 1) {
            cxp = lerp(ax + w / 2, cxp, blend);
            cyp = lerp(ay + h / 2, cyp, blend);
            cxp = clamp(cxp, w / 2 + 8, state.vw - w / 2 - 8);
            cyp = clamp(cyp, h / 2 + 70, state.vh - h / 2 - 12);
          }
          // matérialisation SUR le point (pas de chute d'entrée) ; la sortie
          // balaye peu — c'est la caméra qui quitte le sujet, pas la carte
          const dyT = (1 - enter) * 14 - exit * 6;
          const exT = exit * exit * (3.0 - 2.0 * exit);
          const exDirT = (cxp >= state.vw / 2) ? 1 : -1;
          const xOutT = exT * exDirT * (state.vw * 0.2 + w * 0.5);
          const yOutT = -exT * 40;
          const exitFadeT = smooth(0.5, 1.0, exit);
          const birthT = 0.42 + 0.58 * easeOutBack(enterRaw);
          const squashT = Math.sin(enterRaw * Math.PI) * Math.pow(1 - enterRaw, 1.4) * 0.16;
          const wasVisT = card.cho && card.cho.visible;
          card.cho = {
            visible: true, x: cxp - w / 2 + xOutT, y: cyp - h / 2 + yOutT, dy: dyT,
            z: exit * 60, scale: sTrk * birthT * (1 + exT * 0.06), squash: squashT,
            enter, exit, exitFade: exitFadeT, exTilt: exT * exDirT * 0.5,
            active: local > 0.1 && local < 0.9, snap: !wasVisT,
            anchorPx: [trs.x, trs.y],
          };
          return;
        }
      }

      const dy = (1 - enter) * 38 - exit * 8;
      // PINNED IN SPACE: the card sits at a fixed world point over its subject;
      // the camera dollies through it. zrel > 0 = still ahead of the camera,
      // zrel < 0 = we've flown past it. The card scales up and slides radially
      // away from the vanishing point as it approaches, then dissolves behind us.
      const pin = (card.pin != null ? card.pin : 1) * (card.depth || 1);
      const zrel = (0.6 - local) * 1.5 * pin;
      const persp = 1 / (1 + Math.max(zrel, -0.62) * 0.4);
      const w = card.w || 100, h = card.h || 100;
      const vpx = state.vw * 0.5, vpy = state.vh * 0.44;   // vanishing point
      const x = vpx + (ax + w / 2 - vpx) * persp - w / 2;
      const y = vpy + (ay + h / 2 - vpy) * persp - h / 2;
      const z = exit * 120 * (card.depth || 1);
      // DRIVE-BY EXIT: like passing it in a car — the card tilts slightly and
      // sweeps fluidly off toward its nearest screen edge as the camera moves on.
      const ex = exit * exit * (3.0 - 2.0 * exit);
      const exDir = (ax + w / 2 >= state.vw / 2) ? 1 : -1;
      const xOut = ex * exDir * (state.vw * 0.55 + w);
      const yOut = -ex * 70;
      const exitFade = smooth(0.55, 1.0, exit);
      // bubble birth: the card swells from a droplet, overshoots its native size,
      // rebounds and settles (pure function of p — fully scrub-reversible)
      const birth = first ? 1 : (0.42 + 0.58 * easeOutBack(enterRaw));
      const squash = first ? 0 : Math.sin(enterRaw * Math.PI) * Math.pow(1 - enterRaw, 1.4) * 0.16;
      const scale = persp * birth * (1 + ex * 0.1);
      const wasVis = card.cho && card.cho.visible;
      card.cho = { visible: true, x: x + xOut, y: y + yOut, dy, z, scale, squash, enter, exit, exitFade, exTilt: ex * exDir, active: local > 0.1 && local < 0.9, snap: !wasVis };
    }

    /* ---------- Pointer + magnetic buttons ---------- */
    const magnets = [];
    (cfg.magnetRoot || document).querySelectorAll('[data-magnetic]').forEach(btn => {
      const m = { el: btn, sx: new Spring(0, 160, 18), sy: new Spring(0, 160, 18) };
      btn.addEventListener('pointermove', (e) => {
        const r = btn.getBoundingClientRect();
        m.sx.t = clamp((e.clientX - (r.left + r.width / 2)) * 0.22, -7, 7);
        m.sy.t = clamp((e.clientY - (r.top + r.height / 2)) * 0.22, -5, 5);
      });
      btn.addEventListener('pointerleave', () => { m.sx.t = 0; m.sy.t = 0; });
      magnets.push(m);
    });

    window.addEventListener('pointermove', onPointer, { passive: true });
    function onPointer(e) {
      state.pointer.x = e.clientX / state.vw;
      state.pointer.y = e.clientY / state.vh;
      state.lastInteract = performance.now();
    }

    /* ---------- resize ---------- */
    // Les navigateurs mobiles émettent `resize` à chaque glissement de la barre
    // d'URL. Re-dimensionner là re-cible tout (targets, caméra, ancres) et fait
    // sauter les cartes ; sur pointeur coarse on n'agit que si la LARGEUR change
    // (la rotation passe toujours). Porté de scrub-engine v7.
    let laidOutW = window.innerWidth;
    function onResize() {
      if (coarse && window.innerWidth === laidOutW) return;
      laidOutW = window.innerWidth;
      state.vw = window.innerWidth; state.vh = window.innerHeight;
      renderer.setSize(state.vw, state.vh, false);
      makeTargets(); fitCamera();
      backdropMat.uniforms.uScreenAsp.value = state.vw / state.vh;
      cards.forEach(c => c.measure());
      if (cfg.onResize) cfg.onResize(state);
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    /* ---------- scroll ---------- */
    let scrollY = 0, lastScrollY = 0;
    function onScroll() { const se = document.scrollingElement; scrollY = (se ? se.scrollTop : window.scrollY) || 0; state.lastInteract = performance.now(); }
    window.addEventListener('scroll', onScroll, { passive: true });

    /* ---------- PerfGovernor ---------- */
    let fpsAcc = 0, fpsN = 0, fpsChecked = 0;
    function govern(dt) {
      fpsAcc += dt; fpsN++;
      if (fpsAcc > 2 && fpsChecked < 3) {
        const fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; fpsChecked++;
        // échelle : 2 → 1.5 → 1, puis coupe la dispersion — la netteté du film
        // n'est sacrifiée que si la machine ne tient pas les frames.
        if (fps < 42 && state.dpr > 1) { state.dpr = Math.max(1, state.dpr - 0.5); renderer.setPixelRatio(state.dpr); makeTargets(); }
        else if (fps < 34) { state.quality = 0; } // drop dispersion
      }
    }

    /* ---------- main loop ---------- */
    const sunDir = new THREE.Vector2(-0.5, 0.85);
    let rafId = 0, lastT = performance.now(), running = true, lastLoopTick = performance.now();
    document.addEventListener('visibilitychange', () => {
      running = document.visibilityState === 'visible';
      if (running && !state.destroyed) { lastT = performance.now(); loop(); }
    });
    // Watchdog (scrub-engine v7) : si la chaîne rAF est suspendue et ses
    // callbacks droppés (onglet throttlé, bfcache, webview), on la relance au
    // timer. Coût nul quand les frames tournent normalement.
    const watchdog = setInterval(() => {
      if (state.destroyed || !running) return;
      if (performance.now() - lastLoopTick > 700) {
        cancelAnimationFrame(rafId);
        lastT = performance.now();
        loop();
      }
    }, 500);

    function loop() {
      if (state.destroyed || !running) return;
      rafId = requestAnimationFrame(loop);
      const now = performance.now();
      lastLoopTick = now;
      const dt = Math.min((now - lastT) / 1000, 0.05);
      lastT = now;
      state.time += dt;
      govern(dt);

      // progress
      const p = clamp(scrollY / scrollMax(), 0, 1);
      state.p = p;
      const scrollVel = (scrollY - lastScrollY); lastScrollY = scrollY;

      // fade-in from stone on load
      state.fadeIn = Math.min(1, state.fadeIn + dt * 0.8);

      // focus mode spring
      state.focus += ((state.focusT ? 1 : 0) - state.focus) * Math.min(1, dt * 6);

      // film seek targets (lingerEase : la caméra se pose mi-scène)
      const li = legIndex(p);
      for (let i = 0; i < legs.length; i++) {
        const s = bounds[i], e2 = bounds[i + 1];
        const t = clamp((p - s) / (e2 - s), 0, 1);
        legs[i].target = legs[i].linger ? lingerEase(t, legs[i].linger) : t;
      }
      seekTick();

      // coutures : XF = 0 → mixv reste 0, swap sec de texture au passage de
      // frontière (invisible : la frame affichée est identique des deux côtés).
      // VERROU DE CONVERGENCE (17/07) : le lerp de seek retarde l'image affichée
      // de plusieurs frames sur la cible ; swapper à l'instant du franchissement
      // zappait la fin du leg sortant (le morph de couture) → petite saute.
      // On ne swappe que lorsque le leg sortant a atteint sa frame de frontière
      // (cur→1 en avant, cur→0 en arrière) — tenue < 100 ms, imperceptible.
      // Un flick de plus d'une section snappe directement (pas de course à
      // travers les legs intermédiaires).
      let dl = (state.displayLeg == null) ? li : state.displayLeg;
      if (dl !== li) {
        const out = legs[dl];
        const fwd = li > dl;
        const converged = !out || !out.ready || (fwd ? out.cur >= 0.995 : out.cur <= 0.005);
        if (converged || Math.abs(li - dl) > 1) dl = li;
      }
      state.displayLeg = dl;
      let mixv = 0, iA = dl, iB = dl;
      const bu = backdropMat.uniforms;
      if (externalVideoTex) {
        bu.texA.value = externalVideoTex; bu.texB.value = externalVideoTex; bu.uMix.value = 0;
      } else {
        bu.texA.value = legs[iA].tex; bu.uAspA.value = legs[iA].ready ? legs[iA].asp : 16 / 9;
        bu.texB.value = legs[iB].tex; bu.uAspB.value = legs[iB].ready ? legs[iB].asp : 16 / 9;
        bu.uMix.value = mixv;
      }
      bu.uFocus.value = state.focus;
      bu.uFadeIn.value = state.fadeIn;

      // sun arc: morning upper-left cool -> golden low-right warm
      const arc = p;
      sunDir.set(lerp(-0.55, 0.6, arc), lerp(0.85, 0.35, arc)).normalize();
      const sunWarm = smooth(0.3, 0.95, arc);
      dustMat.uniforms.uTime.value = state.time;
      dustMat.uniforms.uWarm.value = sunWarm;

      // fine-dust sim: motes hang in the air, respond gravitationally to the
      // pointer (repulsion + air entrainment) and stream with scroll airflow
      const pwx = (state.pointer.x - 0.5) * state.vw;
      const pwy = -(state.pointer.y - 0.5) * state.vh;
      if (dustPX === null) { dustPX = pwx; dustPY = pwy; }
      const pvx = (pwx - dustPX) / Math.max(dt, 1e-3), pvy = (pwy - dustPY) / Math.max(dt, 1e-3);
      dustPX = pwx; dustPY = pwy;
      const dDamp = Math.exp(-dt * 2.6);
      const svPS = clamp(scrollVel / Math.max(dt, 1e-3), -2600, 2600);
      for (let i = 0; i < dustN; i++) {
        const ix = i * 3, iv = i * 2;
        let x = dpos[ix], y = dpos[ix + 1];
        const depth = (dpos[ix + 2] - 60) / 300; // nearer motes react more
        let ax = Math.sin(state.time * 0.13 + dph[i]) * 6;
        let ay = Math.cos(state.time * 0.09 + dph[i] * 1.7) * 5;
        const ddx = x - pwx, ddy = y - pwy;
        const d = Math.sqrt(ddx * ddx + ddy * ddy) + 26;
        if (d < 340) {
          const f = 1 - d / 340;
          const g = (2600 * f * f) / d * (0.35 + depth * 0.95);
          ax += (ddx / d) * g; ay += (ddy / d) * g;
          const ent = f * Math.min(1, dt * 4) * 0.22;
          dvel[iv] += (pvx - dvel[iv]) * ent;
          dvel[iv + 1] += (pvy - dvel[iv + 1]) * ent;
        }
        ay += svPS * 0.045 * (0.35 + depth * 1.1);
        dvel[iv] = clamp((dvel[iv] + ax * dt) * dDamp, -520, 520);
        dvel[iv + 1] = clamp((dvel[iv + 1] + ay * dt) * dDamp, -520, 520);
        x += dvel[iv] * dt; y += dvel[iv + 1] * dt;
        const hw = state.vw * 0.62, hh = state.vh * 0.62;
        if (x > hw) x = -hw; else if (x < -hw) x = hw;
        if (y > hh) y = -hh; else if (y < -hh) y = hh;
        dpos[ix] = x; dpos[ix + 1] = y;
      }
      dustGeo.attributes.position.needsUpdate = true;

      // --- render pipeline ---
      renderer.setRenderTarget(rtSharp);
      renderer.clear();
      renderer.render(backdropScene, orthoCam);
      blurMat.uniforms.tex.value = rtSharp.texture;
      blurMat.uniforms.uDir.value.set(1 / rtA.width, 0);
      renderer.setRenderTarget(rtA); renderer.clear(); renderer.render(blurScene, orthoCam);
      blurMat.uniforms.tex.value = rtA.texture;
      blurMat.uniforms.uDir.value.set(0, 1 / rtA.height);
      renderer.setRenderTarget(rtB); renderer.clear(); renderer.render(blurScene, orthoCam);

      renderer.setRenderTarget(null);
      renderer.clear();
      copyMat.uniforms.tex.value = rtSharp.texture;
      copyMat.uniforms.texBlur.value = rtB.texture;
      copyMat.uniforms.uFocus.value = state.focus;
      renderer.render(copyScene, orthoCam);

      const frame = { sunDir, sunWarm, reduceMotion: 0 };
      for (const card of cards) { choreograph(card, p); card.update(dt, frame); }
      renderer.render(glassScene, cam);

      // magnets
      for (const m of magnets) {
        const x = m.sx.step(dt), y = m.sy.step(dt);
        m.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      }

      if (cfg.onFrame) cfg.onFrame(p, state);
    }

    /* ---------- API ---------- */
    const api = {
      tier: 'A',
      registerCard(def) { const c = new GlassCard(def); cards.push(c); return c; },
      setFocus(v) { state.focusT = v ? 1 : 0; },
      scrollToP: makeScrollToP(scrollMax),
      /** PRODUCTION CONTRACT — swap the whole placeholder/leg system for one
       *  scroll-scrubbed master video: pass a THREE.VideoTexture; the backdrop
       *  plane samples it instead. Call with null to restore the legs. */
      setVideoTexture(tex) { externalVideoTex = tex || null; },
      remeasure() { cards.forEach(c => c.measure()); },
      dispose() {
        state.destroyed = true;
        cancelAnimationFrame(rafId);
        clearInterval(watchdog);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('orientationchange', onResize);
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('pointermove', onPointer);
        cards.forEach(c => c.dispose());
        rtSharp.dispose(); rtA.dispose(); rtB.dispose();
        legs.forEach(g => { try { g.video.src = ''; } catch (e) { } if (g.tex && g.tex.dispose) g.tex.dispose(); g.poster.dispose(); });
        renderer.dispose();
      },
    };
    onScroll();
    loop();
    return api;
  }

  function makeScrollToP(scrollMax) {
    return (p) => window.scrollTo({ top: p * scrollMax(), behavior: 'smooth' });
  }

  /* ---------- Tier C: readable static fallback ---------- */
  function mountTierC(cfg, state, docScrollMax) {
    if (cfg.canvas) cfg.canvas.style.display = 'none';
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;inset:0;z-index:0;background:#f2efe9;';
    const img = document.createElement('img');
    img.src = cfg.legs[0].poster; img.alt = '';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    holder.appendChild(img);
    const veil = document.createElement('div');
    veil.style.cssText = 'position:absolute;inset:0;background:rgba(242,239,233,0.35);';
    holder.appendChild(veil);
    (cfg.canvas ? cfg.canvas.parentNode : document.body).insertBefore(holder, cfg.canvas || null);
    document.documentElement.classList.add('het-tier-c');
    let scrollY = 0;
    const onScroll = () => {
      const se = document.scrollingElement;
      scrollY = (se ? se.scrollTop : window.scrollY) || 0;
      // le track est masqué en Tier C : progression sur la hauteur du document
      const p = clamp(scrollY / docScrollMax(), 0, 1);
      // swap poster per leg
      let li = 0; for (let i = cfg.legBounds.length - 2; i >= 0; i--) { if (p >= cfg.legBounds[i]) { li = i; break; } }
      if (img.dataset.li !== String(li)) { img.dataset.li = String(li); img.src = cfg.legs[li].poster; }
      if (cfg.onFrame) cfg.onFrame(p, state);
      if (cfg.onTierCFrame) cfg.onTierCFrame(p);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  window.HETGlass = { mount };
})();
