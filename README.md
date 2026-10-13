# Atea 3D Matuoklis

Fotogrametrijos 3D modelių peržiūros ir matavimo programa (veikia naršyklėje, duomenys niekur nesiunčiami).

**Greitas startas be diegimo:** atsisiųskite [`release/atea-3d-matuoklis.html`](release/atea-3d-matuoklis.html) ir atidarykite jį dukart spustelėję (Chrome / Edge / Firefox). Viskas viename faile.

## Palaikomi formatai

| Tipas | Formatai |
|---|---|
| Tinklai | **OBJ** (+MTL ir tekstūros), **GLB / GLTF** (įskaitant Draco, Meshopt), **PLY**, **FBX**, **DAE**, **3MF**, **STL** |
| Taškų debesys | **LAS** (nesuspaustas, su RGB arba intensyvumu), **PLY**, **PCD**, **XYZ / PTS / TXT / CSV** |
| Archyvai | **ZIP** (pvz. OBJ + MTL + tekstūros viename archyve) |

OBJ modeliui pažymėkite kartu `.obj`, `.mtl` ir tekstūrų failus, atidarykite visą aplanką arba nutempkite ZIP.
Georeferencuotos koordinatės (pvz. LKS-94) apdorojamos dvigubu tikslumu – modelis nesubyra ir koordinatės rodomos originalios.

## Įrankiai

| Klavišas | Įrankis | Ką pateikia |
|---|---|---|
| `D` | Atstumas | 3D atstumas, horizontalus atstumas, aukščių skirtumas, nuolydis |
| `E` | Laužtė | Kelių atkarpų ilgis (3D ir horizontalus), kiekvienos atkarpos ilgis |
| `H` | Aukščių skirtumas | Δ aukštis, horizontalus atstumas, nuolydis % ir ° |
| `K` | Kampas | Erdvinis kampas ir kampas horizontalioje plokštumoje |
| `T` | Taško koordinatės | X, Y, Z originalioje koordinačių sistemoje |
| `A` | Plotas | Horizontalus plotas (m², ha), paviršiaus plotas pagal reljefą, perimetras |
| `V` | Tūris | Pylimas / iškasa / grynasis tūris, masė pagal tankį; pagrindas – plokštuma per kontūrą, žemiausias taškas, vidurkis arba nurodytas aukštis |
| `R` | Aukščio profilis | Reljefo pjūvio grafikas, kilimas / leidimasis, maks. nuolydis, CSV eksportas |
| `S` | Mastelis | Kalibravimas pagal žinomą atstumą (modeliams be georeferencijos) |
| `L` | Išlyginti | Pasuka modelį pagal 3+ taškais pažymėtą žemės plokštumą |

Kiti patogumai:
- `Enter` / dvigubas spustelėjimas / dešinys pelės klavišas – baigti; `Backspace` – atšaukti tašką; `Esc` – nutraukti.
- Kontūrą galima uždaryti spustelėjus pirmą tašką.
- Prikabinimas prie viršūnių (nustatymuose arba laikant `Alt`).
- Atvaizdavimas: tekstūra, apšviesta, reljefas (pilkas), aukščių spalvos su horizontalėmis.
- Pjūvis pagal aukštį – paslėpti medžius / stogus ir matuoti, kas po jais.
- Vaizdai iš viršaus / priekio / šono, ortografinė projekcija (`O`), dvigubas spustelėjimas – sukimosi centras.
- Matavimų eksportas į **CSV** (Excel, lietuviškas formatas), išsaugojimas / įkėlimas **JSON**, ekrano kopija su etiketėmis (`P`).
- Vienetai: m, cm, mm, km, ft; modelio vienetų ir mastelio nustatymai.

## Kūrimas

```bash
npm install
npm run dev          # kūrimo serveris
npm run build        # statinis build'as į dist/ (talpinti bet kuriame serveryje)
npm run build:single # vienas HTML failas į dist-single/
```

Technologijos: [three.js](https://threejs.org), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) (greitas spindulių sekimas dideliems modeliams), Vite.

### Struktūra

- `src/viewer.js` – scena, kameros, atvaizdavimo režimai, taškų parinkimas, paviršiaus aukščių ėmimas
- `src/loaders.js` – failų įkėlimas (įskaitant LAS ir XYZ skaitytuvus, ZIP)
- `src/measurements.js` – matavimų tipai, skaičiavimai ir jų atvaizdavimas
- `src/compute.js` – geometrija: plotai, plokštumos, tūrio ir paviršiaus skaičiavimas tinkleliu, profiliai
- `src/main.js` – sąsaja, įrankių valdymas, eksportas
- `src/style.css` – stiliai; Atea spalvos – `:root` kintamuosiuose (`--atea-green`, `--atea-lime` ir kt.)
