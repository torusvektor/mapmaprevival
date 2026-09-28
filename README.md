MapMap WEB
==========

This PR adds a complete web-based implementation of MapMap, a video mapping (projection mapping) application that runs directly in the browser without requiring installation or external dependencies.
Summary
MapMap Web is a full port of the desktop MapMap application to modern web technologies (JavaScript, WebGL, Canvas). It provides a feature-complete video mapping tool accessible on any device with a web browser, including desktop computers, tablets, and smartphones.
Key Changes
* Core Application Controller (web/js/app.js): Main application logic handling project management, undo/redo history, media import, playback, and the render loop. Implements actions, menus, shortcuts, and selection management.
* Data Model:
    * web/js/model/project.js: Mapping (layer) and project model
    * web/js/model/shapes.js: Shape classes (Mesh, Triangle, Ellipse, Quad) with vertex manipulation
    * web/js/model/paints.js: Paint sources (colors, images, videos, camera feeds)
    * web/js/model/geometry.js: Geometry utilities and affine transformations
* UI Components:
    * web/js/ui/view.js: Editor/output view with WebGL rendering, mouse/touch/pen interaction, pan/zoom controls
    * web/js/ui/panels.js: Side panels for source library, layer list, and property editors
    * web/js/ui/widgets.js: Menus, dialogs, toasts, and file pickers
    * web/js/ui/icons.js: Inline SVG icon library
    * web/js/ui/output.js: Fullscreen presentation and separate output window support
* Rendering:
    * web/js/render/renderer.js: WebGL renderer with shader-based triangle rendering
    * web/js/render/tessellate.js: Converts mappings to WebGL triangles with texture mapping
    * web/js/render/overlay.js: 2D canvas overlay for shape controls, vertices, and test cards
* File I/O & Storage:
    * web/js/io/mmp.js: MapMap project file format reader/writer (.mmp)
    * web/js/io/zip.js: ZIP archive handling for bundled projects (.mmpz)
    * web/js/io/storage.js: IndexedDB persistence for autosave and media caching
* Internationalization (web/js/i18n.js): Multi-language support (Czech, English) with dynamic shortcut formatting
* Utilities:
    * web/js/history.js: Undo/redo system
    * web/js/main.js: Application entry point
    * Service worker (web/sw.js) for offline support and installability
* UI & Assets:
    * web/css/app.css: Responsive dark theme styling for desktop, tablet, and mobile layouts
    * web/index.html: HTML structure with responsive viewport configuration
    * web/manifest.webmanifest: PWA manifest for installability
    * Test signal SVG assets (NTSC, PAL, standard test cards)
    * App icons in multiple formats (SVG, PNG) for web and native app integration
* Documentation (web/README.md): User-facing documentation in Czech and English
Notable Implementation Details
* Cross-platform compatibility: Works on macOS, iOS, Android, and Meta Quest devices
* Media support: Images (PNG, JPG, GIF, WebP, AVIF, HEIC), videos (MP4, MOV, WebM, MKV), live camera feeds
* Responsive design: Adapts to desktop (sidebar + dual views), tablet, and mobile (bottom sheet) layouts
* WebGL rendering: Hardware-accelerated triangle rendering with affine texture mapping
* Bilinear mesh mapping: Matches desktop MapMap's recursive subdivision algorithm
* Touch & pen support: Full multi-pointer interaction with sticky vertices and gesture recognition
* Project compatibility: Can read/write MapMap desktop project files (.mmp/.mmpz)
* Offline capability: Service worker enables

https://claude.ai/code/session_012D79sdUVegHm7pVs9nfaPP


CI status on this PR (updated):
* deploy (Deploy MapMap Web to GitHub Pages): failed because GitHub Pages was not enabled. Fixed in b3193bc: the workflow now deploys only from main, or when started by hand. To publish after merging, enable Settings → Pages → Source: GitHub Actions.
* build (Build on Ubuntu): ✅ fixed in 044a44d. It now builds on ubuntu-24.04 with Qt 5.15 and GStreamer from the Ubuntu packages. Before, jurplel/install-qt-action@v2/aqt 1.2.5 failed on Python 3.14, and GStreamer was never installed.
* build (Build on macOS): ✅ fixed in 88738cf + 0cc10c4.
    * It now uses the native Apple Silicon qt@5 and gstreamer Homebrew packages. src/src.pri finds GStreamer with pkg-config when the official framework is not installed; the official macOS GStreamer packages returned 404.
    * The first real compile on arm64 also exposed a bug in the bundled oscpack: int32 was a 64-bit long on every non-x86_64 64-bit platform. That also affects 64-bit ARM Linux such as a Raspberry Pi. Fixed with an LP64 check, with no change on x86_64 or Windows.
    * src/src.pri now uses QtWebEngine only if it is installed, falling back to the QTextBrowser shortcut window already used on Windows.
* build (Build on Windows): left as it was, at the repository owner's request. The workflow still targets the retired windows-2019 runner image, so this job stays queued and never starts.



Claude Code usage report (2026-09-28T19:17:18.647Z)

Session:
- Opus 5.5: 486 in / 5.7k out / 118.2M cache read / 696.9k cache write
- Cost: $37.75 | API 58m | Wall 77m


MapMap Revival (Windows)
========================

> **Fork maintenu pour Windows 11** - Version portable pour ateliers pédagogiques

:warning: **Ce fork concerne uniquement Windows. Les versions Linux et macOS n'ont pas été corrigées et ne sont pas supportées.**

:robot: **Ce fork a été entièrement mis à jour par l'IA ![Claude](https://img.shields.io/badge/Claude-D97757?style=for-the-badge&logo=claude&logoColor=white) (Anthropic) sur l'initiative de @gilforge pour des travaux étudiants en arts graphiques.**

:globe_with_meridians: **New: MapMap Web** – a browser version that runs on macOS, iOS/iPadOS, Android and
Windows without installation (HTML5/WebGL). See [`web/README.md`](web/README.md). Run it locally with
`cd web && python3 -m http.server 8000`, or publish it with GitHub Pages (Settings → Pages → Source:
GitHub Actions).

MapMap is a free video mapping software.

Projection mapping, also known as video mapping and spatial augmented
reality, is a projection technology used to turn objects, often
irregularly shaped, into a display surface for video projection.
These objects may be complex industrial landscapes, such as buildings.
By using specialized software, a two or three dimensional object is
spatially mapped on the virtual program which mimics the real
environment it is to be projected on. The software can interact with a
projector to fit any desired image onto the surface of that object.
This technique is used by artists and advertisers alike who can add
extra dimensions, optical illusions, and notions of movement onto
previously static objects. The video is commonly combined with, or
triggered by, audio to create an audio-visual narrative.


Version
-------
**0.7.0-windows** (January 2026)

This is a portable version - no installation required. Just extract and run `MapMap.exe`.


Changes from original MapMap 0.6.3
----------------------------------
- Fixed for Windows 11 with Qt 5.15.2 and GStreamer 1.26
- Fixed OpenGL rendering issues (Output Editor refresh)
- Fixed GStreamer auto-configuration (no manual PATH setup needed)
- Fixed shape creation when video dimensions are unavailable
- Replaced heavy QtWebEngine with lightweight QTextBrowser for shortcuts window
- Fixed QOSC library linking for Windows
- Portable version: works without installation


Requirements (Windows)
----------------------
- Windows 10/11 64-bit
- A graphics card with OpenGL support
- For multi-screen output: set Windows display mode to "Extend" (Win+P)


Build from source (Windows)
---------------------------
Prerequisites:
- Qt 5.15.2 MSVC 2019 64-bit
- Visual Studio 2019 Build Tools
- GStreamer 1.26 MSVC 64-bit (development package)

```powershell
# Build
powershell -ExecutionPolicy Bypass -File build.ps1

# Deploy Qt DLLs
powershell -ExecutionPolicy Bypass -File deploy.ps1

# Copy GStreamer DLLs manually from your GStreamer installation
```


Original Authors
----------------
* Sofian Audry: lead developer, user interface designer, project manager.
* Dame Diongue: developer.
* Alexandre Quessy: release manager, developer, technical writer, project manager.
* Mike Latona: user interface designer.
* Vasilis Liaskovitis: developer.


Contributors
------------
* Lucas Adair : developer, macOS packaging.
* Christian Ambaud: sponsor, inspiration.
* Alex Barry: user experience design.
* Eliza Bennett : documentation, chinese translation.
* Jonathan Roman Bland : developer.
* Sylvain Cormier: developer.
* Maxime Damecour: inspiration.
* Louis Desjardins: project manager.
* Ian Donnelly : user interface designer, documentation.
* Gene Felice : video package, documentation.
* Julien Keable: developer.
* Marc Lavallée: help with packaging.
* Matthew Loewens : documentation, developer.
* Madison Suniga : documentation.
* **Gilles Aubin** (@gilforge, gilles-aubin.net) : Windows 11 revival, portable version (2026).


Acknowledgements
----------------
The original MapMap project was made possible by the support of the International
Organization of La Francophonie (http://www.francophonie.org/).

:warning: **Note: This fork (mapmap_revival) is not affiliated with or supported by La Francophonie. The original project is no longer maintained.**

This Windows revival fork was created for educational purposes using AI-assisted development.


More info
---------
* Original project: http://mapmap.info
* Original repository: https://github.com/mapmapteam/mapmap


Licence
-------
[GNU GPL v3](https://github.com/mapmapteam/mapmap/blob/develop/LICENSE)
