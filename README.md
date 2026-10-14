# Atea 3D Matuoklis

Fotogrametrijos 3D modelių kūrimo, peržiūros ir matavimo programa. Matavimai vyksta naršyklėje; 3D modeliai iš drono nuotraukų kuriami jūsų serveryje su [OpenDroneMap](https://opendronemap.org).

**Greitas startas be diegimo:** atsisiųskite [`release/atea-3d-matuoklis.html`](release/atea-3d-matuoklis.html) ir atidarykite jį dukart spustelėję (Chrome / Edge / Firefox). Viskas viename faile.

## Palaikomi formatai

| Tipas | Formatai |
|---|---|
| Tinklai | **OBJ** (+MTL ir tekstūros), **GLB / GLTF** (įskaitant Draco, Meshopt), **PLY**, **FBX**, **DAE**, **3MF**, **STL** |
| Taškų debesys | **LAS / LAZ** (su RGB arba intensyvumu), **PLY**, **PCD**, **XYZ / PTS / TXT / CSV** |
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
| `C` | Kontrolinis taškas | Modelio ir geodeziškai išmatuoto taško skirtumai ΔX, ΔY, ΔH; RMS; pataisos pritaikymas |

Kiti patogumai:
- **Kalba: LT / EN** – perjungiklis viršutinėje juostoje (pasirinkimas įsimenamas). Vertimai – `src/i18n.en.js`.
- `Enter` / dvigubas spustelėjimas / dešinys pelės klavišas – baigti; `Backspace` – atšaukti tašką; `Esc` – nutraukti.
- Kontūrą galima uždaryti spustelėjus pirmą tašką.
- Prikabinimas prie viršūnių (nustatymuose arba laikant `Alt`).
- Atvaizdavimas: tekstūra, apšviesta, reljefas (pilkas), aukščių spalvos su horizontalėmis.
- Pjūvis pagal aukštį – paslėpti medžius / stogus ir matuoti, kas po jais.
- Vaizdai iš viršaus / priekio / šono, ortografinė projekcija (`O`), dvigubas spustelėjimas – sukimosi centras.
- **Žemėlapis po modeliu** (`M` arba mygtukas su žemėlapio ženklu) – palydovinė nuotrauka (Esri), OpenStreetMap arba bet koks XYZ plytelių adresas (`https://…/{z}/{x}/{y}.png`). Žemėlapis dedamas pagal modelio koordinates (LKS-94 arba UTM). Kiekviena plytelė perskaičiuojama iš Web Mercator į modelio sistemą, todėl modelis atsiduria tikroje vietoje. Tikrinant su ODM projektu, žemėlapis nuo modelio buvo pasislinkęs ~4 cm. Galutinį tikslumą lemia pats žemėlapis: palydovinių nuotraukų paklaida dažnai siekia 1–3 m. Permatomumas keičiamas nustatymuose. Modeliams be koordinačių sistemos (pvz. OBJ be `coords.txt`) žemėlapis nerodomas. Reikia interneto ryšio.
- Matavimų eksportas į **CSV** (Excel, lietuviškas formatas), išsaugojimas / įkėlimas **JSON**, ekrano kopija su etiketėmis (`P`).
- Vienetai: m, cm, mm, km, ft; modelio vienetų ir mastelio nustatymai.

## Dirbtinis intelektas (vietinis, nemokamas)

Veikia jūsų serveryje (`deploy/ai`, Docker), be interneto ir be prenumeratų. Abu modeliai – **Apache 2.0** (galima naudoti komerciškai):

| Įrankis | Klavišas | Modelis | Ką daro |
|---|---|---|---|
| **AI kontūras** | `I` | [MobileSAM](https://github.com/ChaoningZhang/MobileSAM) | Spustelite ant krūvos, stogo ar aikštelės – AI apibrėžia kontūrą ir sukuria tūrio (arba ploto) matavimą. ~1 s procesoriumi. |
| **Transporto aptikimas** | `X` | [RF-DETR](https://github.com/roboflow/rf-detr) (Medium, COCO) | Suranda automobilius, sunkvežimius, autobusus (ir pasirinktinai žmones, dviračius…) visame modelyje; sąrašas su LKS-94 koordinatėmis ir CSV (ilgis, plotis, aukštis, kryptis). |

Kaip veikia: naršyklė iš 3D modelio nupiešia vaizdą iš viršaus (kaip ortofoto, ~6 cm/px), AI paslauga grąžina pikselių koordinates,
o programa jas paverčia modelio / LKS-94 koordinatėmis ir aukščiais.
Nustatymuose: AI adresas, ieškomos klasės, patikimumo slenkstis, ką kuria AI kontūras (tūrį ar plotą).

Kaip atmetami klaidingi radiniai: kiekvienam objektui MobileSAM nustato tikslų pasuktą kontūrą, todėl matomi tikri ilgis ir plotis. Netikėtino dydžio objektai (suoliukai, akmenys, šuliniai) atmetami, o klasė (automobilis / sunkvežimis / autobusas) patikslinama pagal ilgį. Programa dar pagal 3D modelį patikrina, ar objektas iškilęs virš aplinkos (≥ 0,5 m), todėl atmetami kelio ženklinimas ir šešėliai. Saulėtą dieną į kontūrą kartais patenka automobilio šešėlis – tada plotis būna keliais dešimtimis cm per didelis.

Pastabos: RF-DETR apmokytas su COCO (ne drono) vaizdais – automobilius iš viršaus randa gerai, bet retesnę techniką (ekskavatorius ir pan.) atpažins tik papildomai apmokius su savais vaizdais.
YOLO (Ultralytics) sąmoningai nenaudojamas dėl AGPL licencijos.

## 3D modelio kūrimas iš drono nuotraukų

Mygtukas **„Iš nuotraukų“** atidaro projekto kūrimo langą:

1. **Nuotraukos** – nutempkite aplanką. Naršyklė perskaito EXIF ir DJI XMP (pirmus ~0,5 MB kiekvienos nuotraukos, 1000 nuotraukų per kelias sekundes) ir parodo:
   RTK FIX / FLOAT dalį, RTK tikslumą (`RtkStdLat/Lon/Hgt`), skrydžio aukštį, GSD, plotą, skrydžio žemėlapį LKS-94 ir įspėjimus.
   DJI Mavic 3T terminės (`_T`) ir priartinimo (`_Z`) nuotraukos praleidžiamos automatiškai. `gcp_list.txt` (jei pridėtas) perduodamas ODM.
2. **Nustatymai** – kokybė (greitas / standartinis / aukšta), DSM, DTM, ortofoto, aukščių sistema:
   - *Elipsoidiniai* (RTK numatytasis) → normaliniai LAS07: `H = h − N`, kur N – kvazigeoido aukštis (vienas skaičius objektui arba LIT15G tinklelio failas `.gtx` / Gravsoft `.gri` / `platuma ilguma N`).
   - Galima palikti elipsoidinius ir pataisyti kontroliniais taškais.
3. **Apdorojimas** – nuotraukos įkeliamos dalimis (su pakartojimais), kartu siunčiamas `geo.txt` su perskaičiuotais aukščiais ir RTK tikslumais (FIX nuotraukos gauna didesnį svorį).
   Eiga matoma projektų sąraše, naršyklę galima uždaryti. Baigus – **„3D modelis“** arba **„Taškai“** atsidaro iškart.

### Koordinatės

OpenDroneMap rezultatus visada pateikia WGS84 / UTM (Lietuvoje – 34N arba 35N). Programa juos **automatiškai perskaičiuoja į LKS-94 (EPSG:3346)**:
tekstūruotą modelį (`odm_textured_model_geo.obj` + `coords.txt` poslinkis) ir taškų debesį (`.laz`).
Transformacija – skersinė Merkatoriaus projekcija su 6 eilės Krüger eilute; patikrinta su PROJ (pyproj) – skirtumas < 0,001 mm.
LKS-94 koordinatės rodomos geodeziniu žymėjimu (X – šiaurė, Y – rytai), galima perjungti nustatymuose.

Prielaidos ir tikslumas:
- RTK pataisos turi būti ETRS89 sistemoje (pvz. **LitPOS** NTRIP). Kitų tinklų (ITRF) koordinatės gali skirtis ~0,7 m – tai matysite kontroliniuose taškuose.
- DJI `AbsoluteAltitude` su RTK paprastai yra elipsoidinis aukštis, bet tai priklauso nuo DJI Pilot 2 nustatymų ir XMP versijos – patikrinkite bent vienu kontroliniu tašku.
- Ortofoto ir DSM/DTM GeoTIFF failai archyve `all.zip` kol kas lieka UTM sistemoje (perprojektuoti galima QGIS / `gdalwarp -t_srs EPSG:3346`).

### Serverio diegimas

#### Windows (Docker Desktop)

1. Įdiekite [Docker Desktop](https://www.docker.com/products/docker-desktop/) ir jį paleiskite.
2. Atsisiųskite visą projektą (GitHub → **Code → Download ZIP**) ir išskleiskite.
3. Atidarykite aplanką `deploy` ir dukart spustelėkite **`start-windows.bat`**.
   Jis sukurs `.env` su slaptu raktu, paleis serverį ir atidarys `http://localhost:8080`.
   Jei prievadas 8080 jau užimtas kitos programos, failas pats parinks laisvą (8081, 8082…), įrašys jį į `deploy/.env` (`WEB_PORT`) ir atidarys teisingą adresą.
4. Programoje **„Iš nuotraukų“** palikite adresą `./odm/`, o rakto laukelį – tuščią: per `http://localhost:8080` raktą prideda serveris.

Kai naudojate vieno failo versiją (`release/…html`), programa pati suranda vietinį serverį prievaduose 8080–8099 (pvz. `http://localhost:8081/odm/` ir `/ai/`). Jei jungiatės tiesiai prie NodeODM (ne per 8080), įveskite `NODEODM_TOKEN` reikšmę iš `deploy/.env`.
Docker Desktop pagal nutylėjimą WSL2 skiria tik dalį RAM. Dideliems projektams sukurkite `%UserProfile%\.wslconfig`:

```ini
[wsl2]
memory=48GB
processors=12
```

**Jei kas nors neveikia** (komandos – aplanke `deploy`):

```bat
docker compose ps              :: visų dalių būsena (turi būti „running“)
docker compose logs --tail 50 ai
docker compose logs --tail 50 web
docker compose restart ai
```

`start-windows.bat` pabaigoje pats patikrina AI paslaugą ir, jei ji neatsako, parodo jos pranešimus.

#### Linux serveris

Reikia Linux serverio su Docker. Rekomendacijos: 1000 nuotraukų (48 MP) – 16+ branduolių, **64–128 GB RAM**, 500 GB+ SSD; NVIDIA GPU pagreitina.

```bash
cd deploy
cp .env.example .env        # įrašykite NODEODM_TOKEN
docker compose up -d --build
# su GPU:
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

Programa bus `http://serveris:8080`, NodeODM – per `/odm/` (programoje numatytas adresas). Rezultatai serveryje laikomi 30 dienų (`NODEODM_KEEP_MINUTES`).
Vieno failo versijai (`release/…html`) nurodykite pilną adresą, pvz. `http://serveris:8080/odm/`.

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
- `src/style.css` – stiliai (tamsus režimas); Atea spalvos pagal atea.lt – `:root` kintamuosiuose (`--atea-green` #008B01, `--atea-graphite` #1F2326, `--atea-forest` #1D4629)
- `src/logo.js` – ATEA žodinis ženklas (SVG, perpieštas; oficialų SVG galima įdėti vietoje `LOGO_PATHS`)
- `src/i18n.js`, `src/i18n.en.js` – kalbos perjungimas ir anglų kalbos žodynas (raktas – lietuviškas tekstas)
- `src/odm/` – nuotraukų EXIF/XMP skaitymas, projekto analizė, `geo.txt`, NodeODM klientas, rezultatų archyvo skaitymas srautu, sąsaja
- `src/geo/` – LKS-94 / UTM projekcijos, UTM → LKS-94 perskaičiavimas, geoido modeliai, žemėlapis po modeliu (`basemap.js`)
- `deploy/` – Docker Compose: NodeODM + AI paslauga + nginx su programa
- `deploy/ai/` – vietinė AI paslauga (FastAPI: `/detect`, `/segment`)
- `src/ai/` – vaizdas iš viršaus AI modeliams ir AI paslaugos klientas
