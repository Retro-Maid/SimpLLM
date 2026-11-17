<div align="center">

<img src="img/simpllm-readme.png" alt="SimpLLM" width="100%">

<p>
  <a href="README.md">日本語</a> ·
  <a href="README.en.md">English</a> ·
  <b>Deutsch</b> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ko.md">한국어</a>
</p>

<img src="https://readme-typing-svg.demolab.com?font=DotGothic16&amp;size=24&amp;duration=3000&amp;pause=1500&amp;color=7D8590&amp;center=true&amp;vCenter=true&amp;width=720&amp;height=44&amp;lines=Lokales+LLM+per+Doppelklick;Die+Chats+bleiben+auf+dem+PC;Kein+Python%2C+kein+Node.js;Chat%2C+Bilder%2C+PDF%2C+gespeicherter+Verlauf" alt="Lokales LLM per Doppelklick. Die Chats bleiben auf dem PC. Kein Python, kein Node.js. Chat, Bilder, PDF, gespeicherter Verlauf">

<p>
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?style=for-the-badge&amp;labelColor=111111" alt="Windows 10 | 11">
  <img src="https://img.shields.io/badge/PowerShell-5.1-5391FE?style=for-the-badge&amp;labelColor=111111" alt="PowerShell 5.1">
  <img src="https://img.shields.io/badge/llama.cpp-b11669-E8E8E8?style=for-the-badge&amp;labelColor=111111" alt="llama.cpp b11669">
  <img src="https://img.shields.io/badge/NVIDIA-CUDA%2012.4-76B900?style=for-the-badge&amp;labelColor=111111" alt="NVIDIA CUDA 12.4">
  <img src="https://img.shields.io/badge/Browser-Chrome%20%7C%20Edge-4285F4?style=for-the-badge&amp;labelColor=111111" alt="Browser Chrome | Edge">
</p>

<p>
  <a href="https://github.com/Retro-Maid/SimpLLM/releases"><img src="https://img.shields.io/github/v/release/Retro-Maid/SimpLLM?style=for-the-badge&amp;labelColor=111111" alt="Neuestes Release"></a>
  <a href="https://github.com/Retro-Maid/SimpLLM/commits"><img src="https://img.shields.io/github/last-commit/Retro-Maid/SimpLLM?style=for-the-badge&amp;labelColor=111111" alt="Letzter Commit"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-F2C94C?style=for-the-badge&amp;labelColor=111111" alt="License MIT"></a>
  <a href="https://github.com/Retro-Maid/SimpLLM/releases"><img src="https://img.shields.io/github/downloads/Retro-Maid/SimpLLM/total?style=for-the-badge&amp;labelColor=111111" alt="Downloads"></a>
  <a href="https://github.com/Retro-Maid/SimpLLM/stargazers"><img src="https://img.shields.io/github/stars/Retro-Maid/SimpLLM?style=for-the-badge&amp;labelColor=111111" alt="Sterne"></a>
</p>

<p>
  <a href="#quickstart">Schnellstart</a> ・
  <a href="#features">Was es kann</a> ・
  <a href="#compare">Vergleich</a> ・
  <a href="#requirements">Voraussetzungen</a> ・
  <a href="#troubleshooting">Wenn es nicht läuft</a>
</p>

</div>

<div align="center">
<img src="img/de_guidance.png" alt="SimpLLM einrichten: 1 Ordner ablegen, 2 llama.cpp besorgen, 3 Modell herunterladen, 4 starten" width="100%">
</div>

<a id="quickstart"></a>

## Schnellstart (schneller als eine Tasse Instantnudeln)

1. **SimpLLM holen** — die zip von den [Releases](https://github.com/Retro-Maid/SimpLLM/releases/latest) herunterladen und entpacken. Jeder Ordner mit Schreibrechten passt, zum Beispiel `C:\simpllm`
2. **llama.cpp dazulegen** — diese beiden Dateien von den [offiziellen Releases](https://github.com/ggml-org/llama.cpp/releases) laden und ihren Inhalt direkt nach `bin\` legen (den Inhalt, nicht den Ordner)

   ```
   llama-<Version>-bin-win-cuda-12.4-x64.zip
   cudart-llama-bin-win-cuda-12.4-x64.zip
   ```

3. **Modell ablegen** — eine beliebige `.gguf` nach `models\` legen
4. **Starten** — Doppelklick auf `start.bat`

Sobald das Fenster offen ist, kann man loslegen. Das geht vermutlich schneller als die drei Minuten, die die Nudeln ziehen müssen (der Download des Modells zählt nicht mit).

<a id="features"></a>

## Was es kann

Ordner herunterladen. llama.cpp herunterladen. Ein Modell nach Wahl dazulegen. Doppelklick auf `start.bat`, fertig.

- **Keine Installation** — es gibt kein Installationsprogramm, und in die Registry wird nichts geschrieben. Wer es nicht mehr braucht, löscht den Ordner.
- **Keine Zusatzsoftware** — kein Python, kein Node.js, kein Docker. Es läuft mit der PowerShell, die Windows mitbringt, und mit Chrome oder Edge.
- **Etwa 1 MB** — llama.cpp und die Modelle besorgt man selbst. SimpLLM allein ist etwa 1 MB groß.
- **Eine HTML-Seite** — kein Framework, keine externen Bibliotheken.
- **Startet schnell** — zuerst öffnet sich das Fenster, das Modell lädt im Hintergrund. Auf dem Entwicklungs-PC vergehen vom Start bis kurz vor dem Öffnen des Fensters etwa 0,45 Sekunden.
- **Zu heißt aus** — wer das Fenster schließt, beendet auch den Server. Im Hintergrund bleibt nichts zurück.
- **Bleibt leicht, auch mit vielen Chats** — mehr Chats machen es kaum langsamer. Zuerst wird nur die Liste gelesen, der Text eines Chats erst beim Öffnen.

Die Funktionen in einer Tabelle:

| | |
|---|---|
| Chat | Neu generieren, bearbeiten, abzweigen, Modell wechseln, Systemprompts speichern |
| Anhänge | Textdateien, PDFs, Bilder (Bilder nur mit einem Modell, das eine `mmproj` hat) |
| Bilder generieren und bearbeiten | Verfügbar, sobald stable-diffusion.cpp und ein Bildmodell vorhanden sind |
| Verlauf | Chats, Bilder und Einstellungen werden automatisch gespeichert. Ordner, Anheften, Suche, Export als JSON oder Markdown |
| Erweiterte Funktionen | Lokale Tools, Projekte und btw für eine kurze Zwischenfrage, ohne den Hauptchat zu unterbrechen |
| Anzeigesprachen | Japanisch, Englisch, vereinfachtes Chinesisch, traditionelles Chinesisch, Koreanisch, Deutsch |
| Privatsphäre | Die Chats verlassen den PC nicht. Auch die Seite spricht nicht mit der Außenwelt |

<a id="compare"></a>

## Im Vergleich mit anderen Chat-Clients (leicht! einfach! ohne Installation!)

| | SimpLLM | LM Studio | Ollama | Open WebUI | TextGen (früher text-generation-webui) |
|---|---|---|---|---|---|
| Einrichtung | Ordner ablegen | Installationsprogramm | Installationsprogramm | Docker oder Python | Portable Version (etwa 700 MB) oder eine Version, die eine komplette Python-Umgebung installiert (etwa 10 GB) |
| Was zusätzlich nötig ist | llama.cpp (von den offiziellen Releases nach `bin\`) | Nichts | Nichts | Eine Inferenz-Software (zum Beispiel Ollama) | Nichts |
| Größe der Anwendung | Etwa 1 MB | Komplette Anwendung | Komplette Anwendung | Container oder komplette Python-Umgebung | Siehe oben |
| Betriebssysteme | Nur Windows | Windows, macOS, Linux | Windows, macOS, Linux | Windows, macOS, Linux | Windows, macOS, Linux |
| Modelle beschaffen | Selbst laden und ablegen | In der Anwendung suchen und laden | Per Befehl laden | Hängt von der angebundenen Software ab | Selbst mitbringen oder über die Oberfläche laden |
| Mehrere Nutzer | Nein (ein PC, eine Person) | Nein | Nein | Ja (mit Konten) | Nein |

Gedacht ist es für alle, die unter Windows ihre vorhandenen Modelle sofort laufen lassen wollen, ohne etwas zu installieren. Wer macOS oder Linux nutzt, Modelle in der Anwendung suchen oder das Ganze mit mehreren teilen möchte, ist mit einer anderen Software besser bedient.

<a id="requirements"></a>

## Voraussetzungen

| | |
|---|---|
| Betriebssystem | Windows 10 (ab 1809) oder Windows 11. Unter macOS und Linux läuft es nicht |
| Browser | Chrome oder Edge. Edge ist bei Windows schon dabei |
| GPU | NVIDIA empfohlen |
| Speicher | RAM und VRAM zusammen sollten größer sein als die Modelldatei. Reicht es nicht, wird der Grund beim Start angezeigt |

Für llama.cpp diese beiden Dateien von den [offiziellen Releases](https://github.com/ggml-org/llama.cpp/releases) laden und nach `bin\` legen. Getestet wurde mit der Version b11669.

```
llama-<Version>-bin-win-cuda-12.4-x64.zip
cudart-llama-bin-win-cuda-12.4-x64.zip
```

Manches ist nicht ausprobiert.

- Ein PC ohne NVIDIA-GPU. Es sollte auf der CPU laufen, nur langsamer. Auf dem Entwicklungs-PC wurde es mit entferntem CUDA geprüft, weiter nicht
- GPUs von AMD und Intel. Die CUDA-Version nutzt sie nicht. Mit der Vulkan-Version (`llama-<Version>-bin-win-vulkan-x64.zip`) in `bin\` könnte es gehen

Die Anzeigesprache richtet sich zunächst nach der Sprache von Windows. Ändern lässt sie sich in den Einstellungen unter „Allgemein“.

<a id="troubleshooting"></a>

## Wenn es nicht läuft

Wenn es nicht startet oder ein Modell nicht laden kann, steht der Grund im Fenster oder in einem Hinweisfenster. Das zuerst lesen.

<details>
<summary><b>Es startet nicht oder das Modell lädt nicht</b></summary>

- Den Inhalt der zip direkt nach `bin\` legen, nicht als Ordner. Beide zips werden gebraucht
- Zu wenig Speicher? In den Einstellungen unter „Startoptionen“ die Kontextlänge verkleinern (zum Beispiel 8192). Ein kleineres Modell hilft auch
- Mit einem alten NVIDIA-Treiber geht es nicht. Bitte aktualisieren
- Die Modelldatei ist abgeschnitten oder beschädigt → neu herunterladen
- Eine neue Art von Modell kann ein altes llama.cpp nicht lesen. Den Inhalt von `bin\` durch eine neuere Version ersetzen

</details>

<details>
<summary><b>Nach einer geänderten Einstellung geht nichts mehr</b></summary>

In den Einstellungen unter „Startoptionen“ auf „Zurücksetzen“ drücken. Eine Einstellung, mit der der Server nicht mehr startet, wird schon beim Übernehmen automatisch zurückgenommen.

</details>

<details>
<summary><b>Bilder lassen sich nicht anhängen</b></summary>

- „Dieses Modell unterstützt keine Bildeingabe“ → die passende `mmproj*.gguf` in denselben Ordner wie das Modell legen
- „Die Bildeingabe im Chat ist aus“ → in den Einstellungen unter „Startoptionen“ die „Bildeingabe im Chat“ einschalten

</details>

<details>
<summary><b>Die Generierung ist langsam</b></summary>

Ohne GPU läuft es auf der CPU, und das ist nun einmal langsam. Mit GPU lässt es sich unter „Startoptionen“ bei „Erweitert“ einstellen.

</details>

<details>
<summary><b>Sonstiges</b></summary>

„Weder Chrome noch Edge wurde gefunden“. Ein Chromium-Browser an einem anderen Ort lässt sich angeben (Brave geht auch).

```
start.bat -Browser "<Pfad der ausführbaren Datei>"
```

Port 8080 ist belegt. Wurde keine Nummer vorgegeben, nimmt es einfach eine freie.

Es wird gar kein Grund angezeigt. Dann lässt sich die Ausgabe des Servers direkt ansehen.

```
start.bat -ShowServerLog
```

</details>

## Einstellungen

Zu öffnen über „Einstellungen“ unten links.

| Bereich | Inhalt |
|---|---|
| Allgemein | Senden mit der Eingabetaste, erweiterte Funktionen anzeigen, Anzeigesprache |
| Systemprompt | Anweisungen für den aktuellen Chat und gespeicherte, oft genutzte Anweisungen |
| Modelle | Der Modellordner, die Liste der gefundenen Modelle, Einstellungen je Modell |
| Startoptionen | Bildeingabe im Chat, Kontextlänge, Geschwindigkeit |
| Generierung | Temperatur und die übrigen Generierungsparameter |
| Bilder | Zustand und Einstellungen für das Generieren und Bearbeiten von Bildern |
| Tastenkürzel | Die Liste der Tastenkürzel. `Strg+/` öffnet sie ebenfalls |
| Daten | Importieren, exportieren, alles löschen |

Ein paar Anmerkungen.

- Tools, btw, Projekte, Mehrfachauswahl und die Tokenzahl bleiben verborgen, bis „Erweiterte Funktionen anzeigen“ eingeschaltet ist. Nur die Kontextnutzung erscheint von selbst, wenn die Grenze näher rückt
- Eine leere Startoption bedeutet den Standard von llama.cpp. Die meisten PCs laufen damit. Die Werte stehen in `.run\launch.json`. Was als Argument übergeben wird, etwa `start.bat -Context 8192`, hat Vorrang
- Auch leere Generierungsparameter bedeuten automatisch: bei Qwen-Modellen die offiziell empfohlenen Werte, sonst der Standard von llama.cpp
- Die Schaltfläche „Bild“ erscheint im Eingabefeld erst, wenn eine Bild-Engine und ein Modell vorhanden sind

## Aktualisieren und Entfernen

Zum Aktualisieren SimpLLM beenden und die neuen Dateien über den bisherigen Ordner kopieren. Folgendes gehört nicht zu einer neuen Version und bleibt deshalb erhalten.

- `history\` … Chats, Bilder, Einstellungen
- `models\` … die eigenen Modelle
- `bin\` … llama.cpp
- `.run\` … Startoptionen und die im Fenster geänderten Modelleinstellungen

Für einen Umzug in einen anderen Ordner `history\`, `models\`, `bin\` und aus `.run\` die Dateien `launch.json`, `model-dir` und `model-settings.json` mitnehmen.

Soll nur llama.cpp neu werden, den Inhalt von `bin\` austauschen.

Zum Entfernen beenden und den Ordner löschen. Nur die Verknüpfung auf dem Desktop (simpllm) muss von Hand weg. Sonst wird nirgends etwas geschrieben.

## Lizenz

[MIT](LICENSE). Privat oder beruflich nutzen, ändern, weitergeben. Nur der Urheberrechtshinweis und der Lizenztext müssen erhalten bleiben.
