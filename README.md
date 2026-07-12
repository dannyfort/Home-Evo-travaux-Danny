# Home Eco Travaux — La Métamorphose

Landing scroll-scrubbée pour Home Eco Travaux (entreprise générale de rénovation à Rouen). Le scroll pilote une caméra qui traverse un plan-séquence continu — un seul monde en diorama argile, du chantier brut à la maison livrée.

## Stack

- HTML statique + [`scrub-engine.js`](scrub-engine.js) : moteur de scroll-scrub vanilla JS, sans dépendance (chargement des clips en blob pour un seek fluide, crossfade aux coutures, fallback `prefers-reduced-motion`, encodages allégés sur mobile).
- Visuels générés (Higgsfield — Seedance 2.0 Mini, style diorama argile) puis upscalés en FHD 30 fps (ByteDance, preset `aigc`).

## Structure

```
index.html          page + configuration des sections (mountScrollWorld)
scrub-engine.js      moteur de scroll-scrub portable
assets/*.webp        posters (fallback + poster vidéo)
assets/vid/leg-*.mp4       clips desktop 1920×1080 30fps
assets/vid/leg-*-m.mp4     clips mobile 1280×720 (GOP court, décodage allégé)
```

## Développement local

Site 100 % statique — servez le dossier avec n'importe quel serveur HTTP :

```
python3 -m http.server 4411
```

## Déploiement

Déployé sur Vercel comme site statique (aucune configuration de build nécessaire).
