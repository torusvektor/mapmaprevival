# MapMap Web

Webová verze programu **MapMap** pro video mapping (projection mapping). Běží přímo v prohlížeči –
na MacBooku, iPhonu, iPadu, Androidu i na Meta Quest – bez instalace, bez Qt a bez GStreameru.

*English summary below.*

## Co umí

Vše podstatné z desktopového MapMap:

- **Zdroje**: obrázky (PNG, JPG, GIF, WebP…), videa (MP4, MOV, WebM…), živá **kamera**
  (webkamera MacBooku, přední/zadní kamera telefonu) a jednobarevné plochy.
- **Vrstvy**: síť (quad s libovolným dělením), trojúhelník, elipsa – barevné i texturované.
- **Vstupní editor** (výřez ze zdroje) a **výstupní editor** (kam se obraz promítá).
- Úpravy tvarů: tažení bodů, posun celého tvaru, režimy *posun bodů → změna velikosti → otáčení*
  (klepnutím na tvar nebo klávesami M / S / R), přichytávání bodů, otočení o 90°/180°,
  převrácení, zamčení, skrytí, sólo, pořadí vrstev, krytí, dělení sítě, číselná úprava bodů.
- **Zpět / znovu** pro všechny úpravy.
- **Výstup na celou obrazovku** a samostatné **výstupní okno** pro projektor (druhý monitor),
  s křížovým kurzorem a úpravou bodů přímo v promítaném obraze, **testovací obrazce**
  (klasický, PAL, NTSC).
- **Ukládání**: projekt se průběžně ukládá v zařízení (po zavření prohlížeče se obnoví).
  *Uložit projekt* vytvoří soubor `.mmpz` (projekt + všechna média) pro přenos mezi zařízeními;
  *Exportovat .mmp* vytvoří soubor kompatibilní s desktopovým MapMap. Soubory `.mmp`
  z desktopu lze otevřít – aplikace pak požádá o výběr chybějících médií.
- Ovládání myší, trackpadem (pinch zoom), dotykem (dva prsty = posun/zoom, dlouhý stisk = menu)
  i klávesnicí (stejné zkratky jako desktop, přehled v *Nápověda → Klávesové zkratky*).
- Čeština a angličtina, instalace jako aplikace (PWA) a běh offline.

Nepodporováno oproti desktopu: OSC ovládání (prohlížeč nemá přístup k UDP) a zdroje přes
sdílenou paměť (`shmsrc`).

## Spuštění

### Varianta A – GitHub Pages (doporučeno, funguje i kamera na telefonu)

1. V repozitáři na GitHubu: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Po každém pushnutí do větve `main` (např. po sloučení pull requestu), které mění složku
   `web/`, workflow `.github/workflows/web-pages.yml` aplikaci zveřejní. Lze ho spustit i ručně
   v záložce *Actions* (*Deploy MapMap Web to GitHub Pages → Run workflow*).
3. Otevřete `https://torusvektor.github.io/mapmaprevival/` na libovolném zařízení.

### Varianta B – lokálně na MacBooku

```sh
cd web
python3 -m http.server 8000
```

Otevřete <http://localhost:8000> v Safari, Chrome nebo Firefoxu. (Stránku je nutné servírovat
přes HTTP server – otevření `index.html` přímo ze souboru nefunguje kvůli JavaScriptovým modulům.)

Na iPhonu/Androidu ve stejné Wi-Fi lze otevřít `http://<IP-adresa-Macu>:8000` –
vše funguje kromě kamery a offline režimu, které prohlížeče povolují jen přes HTTPS.

### Instalace jako aplikace

- **iPhone / iPad (Safari)**: Sdílet → *Přidat na plochu*. Aplikace se pak otevírá přes celou
  obrazovku bez lišty prohlížeče (na iPhonu jinak prohlížeč celou obrazovku nepovolí).
- **Android (Chrome)**: menu ⋮ → *Instalovat aplikaci* / *Přidat na plochu*.
- **Mac (Chrome/Edge)**: ikona instalace v adresním řádku; **Safari 17+**: Soubor → *Přidat do Docku*.

## Promítání

- **MacBook + projektor**: nastavte displeje jako *rozšířenou plochu*, v MapMap zvolte
  *Otevřít výstupní okno*, přesuňte ho na projektor a dvojklikem (nebo klávesou F) ho přepněte
  na celou obrazovku. V Chrome se okno na druhou obrazovku přesune samo (po povolení
  „správy oken“). Rozlišení výstupu nastavte v *Nastavení* (výchozí 1920 × 1080).
- **Telefon / tablet**: *Výstup na celou obrazovku* (ikona monitoru). Připojte projektor kabelem
  (USB-C/HDMI) nebo zrcadlete obrazovku (AirPlay, Chromecast/Smart View). Během promítání
  aplikace brání zhasnutí displeje.
- Klepnutím / pohybem myši se zobrazí panel (ukončit, celá obrazovka, přehrávání, ovládací body,
  testovací obrazec). Body lze doladit přímo v promítaném obraze.

## Tipy k formátům

- Video: nejlépe **MP4 (H.264)** – přehraje ho Safari i Chrome na všech zařízeních. WebM
  nepřehrají starší iPhony, MOV (HEVC) nepřehraje Chrome na Androidu.
- Velké obrázky se pro GPU automaticky zmenší na max. 4096 px (souřadnice se nemění).
- Média se ukládají v prohlížeči; při nedostatku místa uložte projekt jako `.mmpz`.

## Struktura kódu

Čistý JavaScript (ES moduly) + WebGL, bez závislostí a bez build kroku.

| Soubor | Obsah | Originál (C++) |
| --- | --- | --- |
| `js/model/shapes.js` | Triangle, Mesh, Ellipse, omezení bodů | `src/shape/*` |
| `js/model/paints.js` | barva, obrázek, video, kamera | `src/core/Paint.*` |
| `js/model/project.js` | vrstvy, viditelnost/sólo, pořadí | `src/core/Mapping.*`, `MappingManager.*` |
| `js/io/mmp.js` | čtení/zápis `.mmp` | `ProjectReader/Writer.cpp` |
| `js/render/*` | WebGL vykreslování, ovládací body, testovací obrazce | `ShapeGraphicsItem.cpp`, `OutputGLCanvas.cpp` |
| `js/ui/view.js` | editory a výstup (myš, dotyk, zoom) | `MapperGLCanvas.cpp` |
| `js/app.js` | akce, menu, zkratky, zpět/znovu, soubory | `MainWindow.cpp`, `Commands.cpp` |

---

## English summary

MapMap Web is a browser port of the MapMap projection mapping software (HTML5 + WebGL, no
dependencies, no build step). It supports image, video, camera and color sources; mesh, triangle
and ellipse layers; input/output editors with mouse, trackpad and touch; undo/redo; fullscreen
output and a separate output window for a projector; test cards; autosave in the browser;
portable `.mmpz` bundles and desktop-compatible `.mmp` files. Czech and English UI.

Run locally with `cd web && python3 -m http.server 8000` and open <http://localhost:8000>, or
publish it with GitHub Pages (Settings → Pages → Source: GitHub Actions; the workflow
`.github/workflows/web-pages.yml` deploys `web/`). HTTPS is required for the camera and offline
mode on phones.

License: GNU GPL v3, like MapMap.
