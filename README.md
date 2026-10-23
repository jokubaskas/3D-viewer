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

## Skrydžio planas

Viršutinėje juostoje paspauskite **„Planas“**.

**Teritorija.** Ją galima:
- pažymėti žemėlapyje (taškus galima tempti, kraštinės viduryje pridėti naują tašką, dešiniuoju pelės mygtuku pašalinti);
- įkelti iš KML ar GeoJSON;
- surasti pagal adresą ar koordinates.

**Kamera.** Pasirinkite iš sąrašo (Anzu Raptor T / Mavic 3T, Mavic 3E, Matrice 4E, Phantom 4 RTK, M30T) arba nuskaitykite iš vienos savo drono nuotraukos (EXIF).

**Tikslumas.** Įveskite norimą GSD (cm/px) – aukštis apskaičiuojamas (arba atvirkščiai). Pvz. Mavic 3E 100 m aukštyje: 2,73 cm/px. Virš 120 m programa įspėja.

**Maršrutas.** „Gyvatėlė“ apskaičiuojama pagal išilginį ir skersinį persidengimą.
- Kryptis parenkama taip, kad linijų būtų mažiausiai, arba nurodoma ranka.
- Kryžminis (dvigubas) skrydis – geresniam 3D modeliui.
- Greitis ribojamas pagal kameros kadro intervalą.

**Skaičiai:** plotas, linijos, nuotraukos, maršruto ilgis, greitis, trukmė (su skrydžiu iki teritorijos, jei pažymėta pakilimo vieta) ir akumuliatorių skaičius.

**Eksportas:**
- **KML** (sritis + maršrutas) – sritį importuokite į pulto programą kaip kartografavimo misiją ir nustatykite parodytus parametrus;
- **DJI WPML (KMZ)** – maršruto taškai su fotografavimu kas N m (DJI Pilot 2 formatas; su Anzu Smart Control dar nebandyta);
- **GeoJSON**.

Planai išsaugomi naršyklėje.

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

**Dronai (diab): būsena ir žemėlapis.** Kortelė „Dronai (diab)“ transliacijos puslapyje jungiasi prie diab (`wss://atea.diab.app/api/ws/v2/dashboard`) taip pat, kaip diab tinklalapis.
- **Raktas:** diab tinklalapyje F12 → Network → WS → `dashboard` → Headers → `Sec-WebSocket-Protocol` (visa reikšmė). Saugomas tik naršyklėje; jei tai JWT, rodoma, iki kada galioja.
- **Ryšys:** „Automatiškai“ – pirma tiesiogiai, nepavykus – per mūsų serverį (`/ext/diab/…`, nginx; leidžiami tik `*.diab.app` adresai).
- **Rodoma:** visi dokai ir dronai – būsena, baterija, RC, vėjas, lietus, temperatūra; įspėjimai (stiprus vėjas ≥ 10 m/s, lietus, baterija < 25 %).
- **Žemėlapis:** dokai, skrendantis dronas (kryptis, aukštis, baterija), nuskristas maršrutas, drono sekimas; maršrutas atsisiunčiamas GPX.
- **Susiejimas su transliacija:** jei transliacijos pavadinime yra doko kodas ar pavadinimas (pvz. „ATEA1“), langelyje rodomi to drono duomenys. AI įraše:
  - drono vieta rodoma vaizde ir įvykių kadruose;
  - `skaiciai.csv` ir `ivykiai.csv` papildomi koordinatėmis;
  - ataskaitoje – nuoroda į vietą žemėlapyje;
  - ZIP'e – `marsrutas.gpx`.
- **Gauti duomenys:** skiltis rodo paskutinį diab pranešimą (be piloto duomenų) – skrydžio metu galima pamatyti visus laukus. Aukštis, kryptis ir greitis rodomi, jei diab juos siunčia.

**AI aptikimas transliacijoje.** Mygtukas ✨ prie transliacijos įjungia žmonių ir transporto aptikimą.
- Kadrai siunčiami į vietinę AI paslaugą (RF-DETR, be interneto); ant vaizdo piešiami rėmeliai, rodomi skaičiai.
- Detalumas:
  - **Greitas** – visas kadras vienu kartu, ~1–3 s;
  - **Įprastas** – kadras skaidomas į 6 dalis;
  - **Detalus** – pilna raiška plytelėmis, mažiems objektams iš didelio aukščio.
- Galima įjungti įspėjimą (garsas ir pranešimas), kai aptinkamas žmogus.
- **Objektų sekimas** („Sekti objektus“, įjungta pagal nutylėjimą):
  - kiekvienas objektas gauna numerį (#1, #2…);
  - kai objektas dingsta iš kadro ir vėl pasirodo, jis atpažįstamas pagal išvaizdą (viršutinės ir apatinės dalies spalvas), todėl skaičiuojamas ne kaip naujas;
  - kiek laiko prisimenamas dingęs objektas, galima pasirinkti (1 min. – visas įrašas);
  - rodoma, kiek objektų matosi dabar ir kiek skirtingų matyta iš viso; įspėjama tik apie naujus objektus;
  - atpažinimas apytikslis: vienodai apsirengę žmonės (vienodos liemenės ir šalmai) gali būti supainioti.
- **Šalmo būsenos fiksavimas** (savo modeliui su šalmų klasėmis, kai objektai sekami):
  - „Žmogus“, „Su šalmu“ ir „Be šalmo“ sekami kaip vienas žmogus, persidengiantys jo rėmeliai sujungiami;
  - kol neaišku, rodoma „Žmogus“; būsena užfiksuojama, kai AI 2 kartus tikras ≥ pasirinktos ribos (60–90 %) arba 1 kartą ≥ riba + 15 %;
  - pavieniai „persigalvojimai“ būsenos nekeičia; ji pakeičiama, kai kita būsena kelis kartus matoma užtikrintai (pvz. žmogus nusiėmė šalmą);
  - įspėjimas ir ataskaita – tik užfiksuotos būsenos.
- AI veikia CPU, todėl transliacijai greičiausias modelis yra `AI_DETECTOR=nano` faile `.env` (tada perkurkite AI: `start-windows.bat`).
- **Kur išsaugoma (prisijungus administratoriui):** originalus vaizdas (be žymėjimų) – skiltyje **Įrašai**, AI ataskaita (ZIP su pažymėtu vaizdu, įvykiais, CSV) – **Ataskaitos**. Abu iš pradžių matomi tik administratoriui; klientams priskiriami ar ištrinami tose skiltyse. Ataskaita kuriama, kai įrašymo pradžioje įjungtas AI. Be serverio (ar klientui) – atsisiunčiama į kompiuterį, kaip anksčiau.
- **Įrašas su AI ir ataskaita klientui:** jei AI įjungtas, įrašymas (⏺) įrašo vaizdą su rėmeliais, skaičiais, data ir laiku. Sustabdžius atsisiunčiamas ZIP:
  - `ataskaita.html` – atsidaro bet kurioje naršyklėje: vaizdo įrašas, santrauka (kai sekama – kiek skirtingų objektų, daugiausia vienu metu, vidutiniškai, kiek laiko matėsi); sekant objektus įvykių sąraše – vienas įrašas kiekvienam objektui (#numeris, visi laikotarpiai, kai matėsi, ir geriausias jo kadras), grafikas laike, įvykių sąrašas – vienas įrašas kiekvienam objektų pasirodymui (AI kortelėje „Į įrašo ataskaitos įvykius“ galima pasirinkti, kurios grupės patenka į įvykius, santrauką ir grafiką – pvz. tik „Be šalmo“; kadruose apvedamos tik jos) (nuo–iki, daugiausia) su geriausiu AI analizuotu kadru, kuriame rėmeliai tiksliai ant objektų; pavieniai praleisti kadrai įvykių nedubliuoja; spustelėjus laiką – peršokama į įrašo vietą; galima spausdinti į PDF;
  - `irasas.mp4 / .webm` – vaizdas su žymėjimais;
  - `skaiciai.csv`, `ivykiai.csv` (Excel), `duomenys.json`, `kadrai/`.
  
  Kadras (📷) su įjungtu AI taip pat išsaugomas su rėmeliais ir laiku.
- **Kaupti kadrus modelio mokymui:** kas kelias sekundes išsaugomas kadras su automatiniais rėmeliais. „Atsisiųsti (ZIP)“ pateikia YOLO formato rinkinį (images/, labels/, data.yaml), jau su klasėmis `helmet` ir `no_helmet`. Rinkinį galima papildyti žymėjimo programoje (CVAT, Label Studio, Roboflow) ir naudoti modelio pritaikymui, pvz. šalmų atpažinimui.

**Savas AI modelis (pvz. šalmai).** Kortelė „Savas AI modelis“ transliacijos puslapyje:
1. Pažymėkite kadrus Label Studio (`docker run -d --name label-studio --restart unless-stopped -p 8085:8080 -v label-studio-data:/label-studio/data heartexlabs/label-studio:latest`, adresas http://localhost:8085) ir eksportuokite **YOLO** formatu (ZIP).
2. **Mokyti naują modelį…** → pasirinkite ZIP, pavadinimą, dydį ir epochų skaičių.
   - Programa parodo kadrų skaičių, klases ir apytikslę trukmę.
   - Mokoma AI konteineryje (`deploy/ai/train.py`, RF-DETR fine-tuning nuo COCO svorių). Rinkinys dalijamas 85 / 15 (mokymas / patikra).
   - Kortelėje rodoma eiga: epocha, likęs laikas, tikslumas (mAP50). Mokymą galima nutraukti.
3. Baigus – **Naudoti**. AI aptikime atsiranda modelio klasės (pvz. `helmet`, `no_helmet`), įspėjimą galima nustatyti pasirinktai klasei (pvz. „be šalmo“).
4. Papildžius rinkinį, eksportuokite visą Label Studio projektą iš naujo ir apmokykite naują modelį. Senus modelius galima ištrinti.

Modeliai saugomi Docker tome `ai-models`, todėl išlieka atnaujinus programą. Procesoriumi mokymas trunka valandas, todėl mokykite, pavyzdžiui, per naktį: „Mažas“ modelis yra ~3 kartus greitesnis už „Didelį“. Su NVIDIA GPU (`docker-compose.gpu.yml`) mokymas yra keliasdešimt kartų greitesnis.

## Paskyros, klientai ir prieiga iš interneto

Kai programa paleista serveryje (`deploy/`, `start-windows.bat`), į ją reikia prisijungti. Vaidmenys:
- **Administratorius** – visos funkcijos: 3D modelių atidarymas, ODM, planavimas, transliacijos, AI mokymas, klientų valdymas.
- **Tema:** antraštėje šalia kalbos perjungiklio – tamsi arba šviesi; įsimenama naršyklėje.
- Kiekvienas langas atsidaro su „← Pradžia“ mygtuku. Retai naudojamos šoninių stulpelių kortelės (pvz. „Dronai (diab)“, „Savas AI modelis“, apdorojimo serveris) sutrauktos; paspaudus pavadinimą – išsiskleidžia, būsena įsimenama.
- Prisijungus atsidaro **pradžios ekranas** su dideliais mygtukais pagal teises. Logotipas arba „Pradžia“ antraštėje grąžina į jį, kaip ir puslapio „×“.
- **Klientas** – tik tai, ką jam priskyrėte. Mygtukai:
  - **Mano 3D modeliai** – peržiūra ir matavimai;
  - **Mano gyvos transliacijos** – žiūrėjimas, AI aptikimas ir atpažįstamų objektų pasirinkimas, kadrai, įrašai;
  - **Mano ataskaitos**, **Mano įrašai** – peržiūra ir atsisiuntimas.

**Kaip tai veikia:**
- Teises tikrina serveris, ne naršyklė. Portalas (`deploy/portal`, FastAPI + SQLite) saugo paskyras, priskyrimus ir failus Docker tome `portal-data`.
- nginx kiekvieną `/odm/`, `/ai/`, `/live/` ir `/ext/` užklausą tikrina per `auth_request`:
  - ODM, AI mokymas ir transliacijų serverio valdymas – tik administratoriui;
  - klientui – tik jam priskirtos transliacijos ir AI aptikimas.
- Kitų klientų duomenys neatskleidžiami – serveris atsako „nėra“.

**Saugumas:**
- slaptažodžiai užšifruojami scrypt (su druska); sesijos slapukas HttpOnly, SameSite=Strict, per HTTPS – Secure;
- keičiančioms užklausoms reikalinga `X-Atea` antraštė (apsauga nuo kitų svetainių užklausų);
- prisijungimo bandymai ribojami;
- kvietimo nuorodos vienkartinės ir galioja 7 dienas;
- išjungus paskyrą sesijos iškart nutraukiamos;
- transliacijos šaltinio adresas ir raktai lieka serveryje – klientas gauna tik kelią;
- transliacijų serveris (MediaMTX) leidžia žiūrėti tik programai (Docker tinklas `atea3d`, 172.29.88.0/24); dronai ir kameros siųsti gali iš vietinio tinklo, bet tiesiai per RTSP / RTMP žiūrėti negalima;
- prieigos tikrinimas atmeta adresus su `..`, `//` ar `%` užkoduotais simboliais (kad nebūtų galima apeiti patikros);
- HTML ir kiti aktyvūs failai tik atsisiunčiami, ne atidaromi naršyklėje.

**Pirmas paleidimas:**
1. `start-windows.bat` paleidžia serverį. Jei administratoriaus dar nėra, jis paprašo el. pašto (arba paleiskite `deploy\create-admin.bat`).
2. Atsiradusią nuorodą atidarykite naršyklėje ir nusistatykite slaptažodį. `create-admin.bat` tinka ir pamiršus slaptažodį.

**Klientai ir duomenys:**
- **Klientas:** „Mano sritis“ → **Klientai** → **Sukurti paskyrą**. Nuorodą nusiųskite klientui (mygtukas „Siųsti el. paštu“) – slaptažodį jis nusistatys pats.
- **3D modeliai, ataskaitos, įrašai:** atitinkamoje skiltyje **Įkelti naują** (galima ir „Įkelti dabar atidarytą modelį“), pažymėkite klientus.
- **Transliacijos:** transliacijos langelyje mygtukas 👤 **Priskirti klientams**.

**Prieiga iš interneto (Cloudflare Tunnel)** – maršrutizatoriuje nieko atidaryti nereikia, HTTPS automatiškai:
1. Domenas (pvz. `atea3d.lt`, ~10 €/m.) turi būti valdomas Cloudflare (nemokamas planas): Cloudflare → **Add a domain** → pakeiskite domeno registratoriaus vardų serverius (nameservers) į Cloudflare nurodytus.
2. Cloudflare **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** → **Cloudflared** → pavadinimas → nukopijuokite **raktą (token)**. Programos diegti nereikia – ji paleidžiama Docker'yje.
3. Tunelio **Public Hostname**: pvz. `3d.atea3d.lt`, **Service**: `HTTP`, `web:80`.
4. `deploy\.env` faile įrašykite `CF_TUNNEL_TOKEN=<raktas>` ir `PUBLIC_URL=https://3d.atea3d.lt`, paleiskite `start-windows.bat`.
5. Rekomenduojama: Cloudflare → **Security** → **WAF** → **Rate limiting rules** – riboti `/api/auth/` užklausas (pvz. 20 per minutę iš vieno IP).

**Pastabos:**
- Kompiuteris turi būti įjungtas ir neužmigęs: Windows → Maitinimas → Miegas: **Niekada**; Docker Desktop → **Start when you sign in**.
- Duomenų atsarginės kopijos: `docker run --rm -v deploy_portal-data:/d -v %cd%:/b alpine tar czf /b/portalas.tgz -C /d .`
- Iš interneto transliacijos rodomos per HLS (~2–5 s vėlavimas): WebRTC vaizdo srautas per tunelį neina.
- Įmonių tinkluose HTTPS ryšius dažnai pasirašo įmonės sertifikatas. `start-windows.bat` (`export-certs.ps1`) kiekvieną kartą perduoda Windows patikimus sertifikatus transliacijų serveriui – be jų serveris negalėtų paimti vaizdo iš https / wheps šaltinio, pvz. diab (žurnale – `x509: certificate signed by unknown authority`).
- Programa, atidaryta iš disko (`release\…html`), su serveriu neprisijungia – serverio funkcijoms atidarykite `http://localhost:8080`.

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
- `src/logo.js` – ATEA logotipas (vektorinis kontūras)
- `src/i18n.js`, `src/i18n.en.js` – kalbos perjungimas ir anglų kalbos žodynas (raktas – lietuviškas tekstas)
- `src/odm/` – nuotraukų EXIF/XMP skaitymas, projekto analizė, `geo.txt`, NodeODM klientas, rezultatų archyvo skaitymas srautu, sąsaja, nuotraukų peržiūra ir srities pasirinkimas (`preview.js`)
- `src/geo/` – LKS-94 / UTM projekcijos, UTM → LKS-94 perskaičiavimas, geoido modeliai, žemėlapis po modeliu (`basemap.js`)
- `deploy/` – Docker Compose: NodeODM + AI paslauga + MediaMTX (transliacijos) + portalas + nginx su programa (+ Cloudflare Tunnel)
- `deploy/portal/` – portalas: paskyros, sesijos, klientų duomenys, prieigos tikrinimas nginx'ui (`app.py`, testai – `test_portal.py`)
- `src/portal/` – prisijungimas, kvietimai (`auth.js`), „Mano sritis“ skiltys ir klientų valdymas (`ui.js`), API (`api.js`)
- `deploy/ai/` – vietinė AI paslauga (FastAPI: `/detect`, `/segment`, `/raster/lks94` – GeoTIFF perskaičiavimas į LKS-94)
- `src/ai/` – vaizdas iš viršaus AI modeliams ir AI paslaugos klientas
- `src/export.js` – 3D modelio išsaugojimas (OBJ su tekstūromis, GLB, LAS)
- `src/compare.js` – palyginimo modelis, pokyčių tinklelis, tūriai ir pokyčių žemėlapis
- `src/plan/` – skrydžio planavimas: kameros, GSD, maršrutas, KML / WPML / GeoJSON (`plan.js`), žemėlapis (`map.js`), sąsaja (`ui.js`)
- `src/live/` – tiesioginės transliacijos (AI aptikimas – `ai.js`): nuorodos atpažinimas ir MediaMTX klientas (`sources.js`), grotuvas su WebRTC / HLS / MJPEG, kadrais ir įrašymu (`player.js`), sąsaja (`ui.js`)
- `src/report/` – PDF ataskaita (jsPDF, įkeliama tik kuriant ataskaitą) ir šriftas
