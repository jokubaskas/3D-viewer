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
- **Išsaugojimas kompiuteryje** (*Modelis → Išsaugoti kompiuteryje*).
  - Atidarytas 3D modelis išsaugomas kaip **OBJ + tekstūros (ZIP)** su tikromis koordinatėmis: LKS-94 georeferencuotiems modeliams, Z – aukštis, 0,1 mm tikslumu, įskaitant kontrolinių taškų pataisą. Tinka CAD ir GIS programoms.
  - Taip pat galima išsaugoti kaip **GLB** peržiūros programoms. GLB koordinatės santykinės, poslinkis įrašomas šakninio mazgo `extras.atea.offset`.
  - Taškų debesis išsaugomas kaip **LAS** (1 mm tikslumu, su spalvomis).
  - Modeliams, sukurtiems „Iš nuotraukų“ (ir projektų sąraše mygtukas *Atsisiųsti*), galima atsisiųsti tikrą ODM **ortofoto**, **DSM**, **DTM** (GeoTIFF), taškų debesį (LAZ) ir originalų ODM 3D modelį. Rastrai gali būti **perskaičiuoti į LKS-94** (EPSG:3346): tai daro AI paslauga su GDAL (`rasterio`), išlaikomas tas pats pikselio dydis, sukuriami peržiūros lygiai. Arba galima atsisiųsti originalią ODM sistemą (WGS84 / UTM).
- **AI skaičiavimų atšaukimas** – transporto paiešką, AI kontūrą ar pokyčių skaičiavimą galima nutraukti mygtuku *Atšaukti* arba `Esc`. AI serveris tada nustoja skaičiuoti ties kita plytele, todėl iškart gali priimti kitą užklausą.
- **Palyginimas su kita data** (*Modelis → Palyginimas su kita data*). Įkeliamas to paties objekto modelis iš kitos datos: ZIP, aplankas ar failas, pvz. kitas ODM projektas. Programa jį padeda pagal koordinates ir tinkleliu palygina abu paviršius. Rezultatai:
  - pridėtas, pašalintas ir grynasis tūris, masė pagal tankį;
  - pokyčių plotai, didžiausias pakilimas ir nusileidimas;
  - spalvotas pokyčių žemėlapis: raudona – pridėta, mėlyna – pašalinta.

  Galima lyginti visą persidengiančią sritį arba pasirinktą *Plotas* / *Tūris* kontūrą. Pokyčiai, mažesni už nejautrumo ribą (numatyta 0,10 m), laikomi fotogrametrijos triukšmu. Patikrinta su pakeistu ODM modeliu: įterpta 157,08 m³ krūva apskaičiuota kaip 157,08 m³, 75,40 m³ duobė – kaip 74,27 m³.
- **PDF ataskaita** (mygtukas *PDF* matavimų skiltyje). Joje gali būti:
  - Atea logotipas, pavadinimas, objektas, autorius ir pastabos;
  - modelio informacija (koordinačių ir aukščių sistema, matmenys);
  - bendras vaizdas ir vaizdas iš viršaus su matavimais, mastelio juosta ir šiaurės rodykle;
  - matavimų suvestinė ir detalės su taškų koordinatėmis;
  - pokyčiai tarp datų su žemėlapiu ir legenda;
  - kontroliniai taškai (RMS) ir AI aptikti objektai.

  Skyrius galima pasirinkti. Šriftas – Inter (SIL OFL 1.1), įterptas su lietuviškomis raidėmis (`src/report/fonts.js`).
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

1. **Nuotraukos** – nutempkite aplanką. Naršyklė perskaito EXIF ir XMP (DJI `drone-dji:`, Anzu Raptor T ir kt. `drone:`) (pirmus ~0,5 MB kiekvienos nuotraukos, 1000 nuotraukų per kelias sekundes) ir parodo:
   RTK FIX / FLOAT dalį, RTK tikslumą (`RtkStdLat/Lon/Hgt`), skrydžio aukštį, GSD, plotą, skrydžio žemėlapį LKS-94 ir įspėjimus.
   DJI Mavic 3T terminės (`_T`) ir priartinimo (`_Z`) nuotraukos praleidžiamos automatiškai. `gcp_list.txt` (jei pridėtas) perduodamas ODM.
   **Peržiūra ir apdorojama sritis.** Iš nuotraukų per kelias sekundes sudėliojamas apytikslis ortofoto. Kiekviena nuotrauka dedama pagal GPS, aukštį virš pakilimo vietos, kameros kryptį (`GimbalYawDegree`) ir objektyvą (35 mm ekvivalentas), po ja rodoma palydovinė nuotrauka.
   Jei visos teritorijos nereikia, pažymėkite sritį (*Žymėti sritį*, taškus galima tempti):
   - ODM gauna ją kaip `boundary` (GeoJSON) ir apkarpo taškų debesį, 3D modelį, DEM bei ortofoto;
   - dar prieš įkėlimą atrenkamos tik nuotraukos, kuriose sritis **aiškiai matosi** (patenka į centrinius 60 % kadro); nuotraukos, kurios sritį tik užkabina kraštu ar visai jos nemato, pritemdomos ir neįkeliamos. Po to patikrinama, kad kiekvieną srities tašką (~400 taškų) matytų bent 5 atrinktos nuotraukos – jei ne, pridedamos artimiausios. Galima pasirinkti ir visas, bent kraštu liečiančias sritį.

   Apdorojimo laikas daugiausia priklauso nuo **nuotraukų skaičiaus**, nes ODM riba apkarpo tik jau sukurtą tankų taškų debesį. Įprastame skrydyje (80 m, 75 % persidengimas) taip naudojama 13–50 % mažiau nuotraukų nei visų liečiančių: kuo mažesnė sritis, tuo daugiau sutaupoma.

   Peržiūra apytikslė: aukštis skaičiuojamas nuo pakilimo vietos, todėl kalvotoje vietovėje mastelis gali skirtis keliais procentais.
2. **Nustatymai** – kokybė (greitas / standartinis / aukšta), DSM, DTM, ortofoto, aukščių sistema:
   - *Elipsoidiniai* (RTK numatytasis) → normaliniai LAS07: `H = h − N`, kur N – kvazigeoido aukštis (vienas skaičius objektui arba LIT15G tinklelio failas `.gtx` / Gravsoft `.gri` / `platuma ilguma N`).
   - Galima palikti elipsoidinius ir pataisyti kontroliniais taškais.
3. **Apdorojimas** – nuotraukos įkeliamos dalimis (su pakartojimais), kartu siunčiamas `geo.txt` su perskaičiuotais aukščiais ir RTK tikslumais (FIX nuotraukos gauna didesnį svorį).
   Eiga matoma projektų sąraše, naršyklę galima uždaryti. Serveris vienu metu apdoroja vieną užduotį (`NODEODM_PARALLEL`), todėl prie laukiančios užduoties parodoma, ko ji laukia. Užduotys, kurių nėra šios naršyklės sąraše, rodomos skiltyje *Kitos užduotys serveryje* (ir baigtos) – jas galima pridėti į sąrašą, atšaukti arba pašalinti. Pvz. pradėtos kitame kompiuteryje arba atidarius programą kitu adresu ar prievadu: projektų sąrašas saugomas naršyklėje atskirai kiekvienam adresui. Jei serveris nieko neapdoroja, o užduotis nepradedama, NodeODM užstrigo: `docker compose restart nodeodm` (užduotys neprarandamos). Baigus – **„3D modelis“** arba **„Taškai“** atsidaro iškart.

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
   Programa visada paleidžiama tuo pačiu adresu **http://localhost:8080**: jei ji jau veikia, naudojamas jos prievadas; po sustabdymo palaukiama, kol Docker atlaisvins 8080. Kitas prievadas (8081…) parenkamas tik tada, kai 8080 tikrai užimtas kitos programos – tada parodoma, kuri programa jį užima. Pastovus adresas svarbus: naršyklė projektų sąrašą ir nustatymus saugo atskirai kiekvienam adresui. Paleidęs failas patikrina, ar programa atsidaro; jei ne – parodo konteinerių būseną ir `web` pranešimus.
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

## Tiesioginė transliacija

Viršutinėje juostoje spauskite **„Transliacija“** ir įklijuokite nuorodą. Vienu metu galima žiūrėti kelias transliacijas (1, 2×2, 3×3 tinklelis). Prie kiekvienos yra mygtukai:
- kadras PNG;
- įrašas (MP4 arba WebM);
- garsas;
- visas ekranas;
- prisijungimas iš naujo.

Nutrūkus ryšiui programa jungiasi iš naujo pati. Jei ryšys nutrūksta įrašant, jau įrašyta dalis išsaugoma. Transliacijos toliau rodomos ir įrašomos, kai grįžtate į 3D vaizdą. Nuorodos įsimenamos šioje naršyklėje.

| Nuoroda | Kaip rodoma | Vėlavimas |
|---|---|---|
| `rtsp://`, `rtmp://`, `srt://` (dronai, IP kameros) | per serverio MediaMTX → WebRTC, jei nepavyksta – HLS | ~0,2–0,5 s (WebRTC) |
| `…m3u8` (HLS) | tiesiogiai; jei šaltinis neleidžia (CORS) – per serverį | 1–3 s |
| `…/whep` (WebRTC), MediaMTX `:8889/kelias` | tiesiogiai | ~0,2 s |
| MP4 / WebM, MJPEG, `snapshot.jpg` | tiesiogiai (kadras atnaujinamas kas sekundę) | — |
| YouTube, Twitch, Vimeo | įterptas grotuvas (be kadrų ir įrašymo) | — |

**Drono transliacija į kompiuterį.** Valdymo pulte (DJI Pilot 2, Anzu Smart Control ir kt.):
1. Pasirinkite **Transliacija → RTMP**.
2. Įveskite adresą `rtmp://<kompiuterio-IP>:1935/drone`. IP sužinosite komanda `ipconfig` → *IPv4 Address*.
3. Transliacija atsiras skiltyje „Gaunamos transliacijos“. Spustelėkite ją, kad pradėtumėte žiūrėti.

Taip pat priimama RTSP (`rtsp://IP:8554/drone`) ir SRT (`srt://IP:8890?streamid=publish:drone`).

Reikalavimai:
- pultas ir kompiuteris turi būti tame pačiame tinkle;
- Windows užkarda turi leisti Docker Desktop.

Paslauga veikia `deploy/` serveryje (konteineris `mediamtx`, nustatymai `deploy/mediamtx.yml`). Naudojami prievadai:
- 1935 – RTMP;
- 8554 – RTSP;
- 8890/udp – SRT;
- 8189 – WebRTC.

RTMP ir RTSP prievadus galima pakeisti `.env` faile (`LIVE_RTMP_PORT`, `LIVE_RTSP_PORT`). Žiūrint per WebRTC iš kito kompiuterio, į `LIVE_HOSTS` įrašykite serverio IP, pvz. `LIVE_HOSTS=127.0.0.1,192.168.1.10`. Be šio nustatymo vaizdas bus rodomas per HLS.

Drono vaizdas paprastai būna H.264 – jį rodo Chrome, Edge, Firefox ir Safari. H.265 (HEVC) rodomas tik naršyklėse, kurios jį palaiko (Chrome / Edge su aparatiniu dekodavimu, Safari).

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
- `src/odm/` – nuotraukų EXIF/XMP skaitymas, projekto analizė, `geo.txt`, NodeODM klientas, rezultatų archyvo skaitymas srautu, sąsaja, nuotraukų peržiūra ir srities pasirinkimas (`preview.js`)
- `src/geo/` – LKS-94 / UTM projekcijos, UTM → LKS-94 perskaičiavimas, geoido modeliai, žemėlapis po modeliu (`basemap.js`)
- `deploy/` – Docker Compose: NodeODM + AI paslauga + MediaMTX (transliacijos) + nginx su programa
- `deploy/ai/` – vietinė AI paslauga (FastAPI: `/detect`, `/segment`, `/raster/lks94` – GeoTIFF perskaičiavimas į LKS-94)
- `src/ai/` – vaizdas iš viršaus AI modeliams ir AI paslaugos klientas
- `src/export.js` – 3D modelio išsaugojimas (OBJ su tekstūromis, GLB, LAS)
- `src/compare.js` – palyginimo modelis, pokyčių tinklelis, tūriai ir pokyčių žemėlapis
- `src/live/` – tiesioginės transliacijos: nuorodos atpažinimas ir MediaMTX klientas (`sources.js`), grotuvas su WebRTC / HLS / MJPEG, kadrais ir įrašymu (`player.js`), sąsaja (`ui.js`)
- `src/report/` – PDF ataskaita (jsPDF, įkeliama tik kuriant ataskaitą) ir šriftas
