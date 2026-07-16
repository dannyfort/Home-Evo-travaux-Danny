# Home Eco Travaux — La Métamorphose

Landing scroll-scrubbée pour Home Eco Travaux (entreprise générale de rénovation à Rouen). Le scroll pilote une caméra qui traverse un plan-séquence continu — un seul chantier photoréaliste filmé en « frozen moments » (actions figées en plein mouvement, débris suspendus, caméra handycam slow-mo), du chantier brut à la maison livrée.

## Direction artistique

**La DA de référence est la v3 photoréaliste « La construction magique »** (commit `f113a0e`) : imagerie CGI high-end façon vrai tournage, brief complet dans [`../da/brief.md`](../da/brief.md). **Toute itération future part de cette version.**

L'ancienne DA diorama argile façon Pixar est archivée — non maintenue, gardée en référence :

- Dossier : [`../landing-3d-pixar-archive/`](../landing-3d-pixar-archive/) (état du commit `289e04e`)
- Démo : https://home-eco-travaux-pixar.vercel.app (projet Vercel `home-eco-travaux-pixar`)

## UI « Liquid Glass » (juil. 2026)

La couche UI est issue du projet claude.design « Liquid Glass Construction Film » : les cartons plats ont été remplacés par des **cartes 3D en verre optique (Three.js r128)** qui flottent dans le film et le réfractent (fresnel, dispersion chromatique, frost variable, streak spéculaire, ripple au clic). Cheminement : hero + carte devis interactive → constellation KPI (débris figés) → 4 cartes services (une par scène du film) → témoignage + portfolio → retour de la carte devis en CTA final — couronné d'une barre de menu cinématique (playhead du film intégré) et d'un rail de progression.

Le film lui-même (6 legs, posters, réglages de dwell) est inchangé — la vidéo du design servait de référence uniquement.

## Stack

- HTML statique + [`glass-engine.js`](glass-engine.js) : moteur du film + verre (WebGL, une passe backdrop → cible de réfraction partagée, cartes = slab WebGL + texte en vrai DOM slavé, springs, chorégraphie au scroll). Porte les durcissements de `scrub-engine.js` v7 : clips desktop/mobile, seeks coalescés, priming iOS, lingerEase par scène, garde resize barre d'URL, watchdog rAF, Tier C statique (`prefers-reduced-motion` / pas de WebGL).
- [`scrub-engine.js`](scrub-engine.js) : ancien moteur v7 (cartons plats), conservé en référence — plus chargé par `index.html`.
- Three.js r128 vendorisé ([`assets/vendor/three.min.js`](assets/vendor/three.min.js)) — pas de CDN en prod.
- Visuels générés (Higgsfield — Seedance 2.0, DA photoréaliste frozen moment) puis upscalés en FHD 30 fps.

## Structure

```
index.html                 page : cartes glass (DOM), menu cinématique, rail, boot (config validée canvas : refraction 0.75 · frost 1.05 · 1100vh)
glass-engine.js            moteur film + liquid glass (HETGlass.mount)
scrub-engine.js            ancien moteur v7 — référence, non chargé
assets/vendor/three.min.js Three.js r128 auto-hébergé
assets/*.webp              posters (fallback + poster vidéo)
assets/portfolio/*.jpg     photos réalisations (covers het-site, optimisées 800px)
assets/vid/leg-*.mp4       clips desktop 1920×1080 30fps
assets/vid/leg-*-m.mp4     clips mobile 1280×720 (GOP court, décodage allégé)
```

## Développement local

Site 100 % statique — servez le dossier avec n'importe quel serveur HTTP :

```
python3 -m http.server 4411
```

## Déploiement

Déployé sur Vercel comme site statique (aucune configuration de build nécessaire) — projet `home-eco-travaux-metamorphose` → https://home-eco-travaux-metamorphose.vercel.app
