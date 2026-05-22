# PRD: Slash menu, AI popup a parita desktop/mobile v editoru

## 1) Executive Summary
Editor dnes neumožňuje konzistentní, rychlé a bezpečné workflow napříč desktopem a mobilem pro vkládání bloků, anotace a AI úpravy vybraného obsahu. Kritický problém důvěry: komentáře se mohou propsat do plain textu editoru (P1), což ohrožuje integritu dokumentu a blokuje release.

Navrhované řešení zavádí: (1) striktní oddělení obsahu a metadat s opravou P1 bugu, (2) slash menu se sjednoceným vzhledem (light/dark), (3) omezené selection menu, (4) řízené AI mini-okno s preview/undo/confirm, a (5) baseline podporu multi-block selekce. Cílem MVP je outcome parita desktop/mobile pro klíčové toky tvorby textu bez regresí v důvěře dat.

**Cíloví uživatelé:**
- Autor obsahu (primární): rychlé vkládání bloků, úpravy výběru, AI asistence.
- Reviewer/editor (sekundární): bezpečné komentování bez kontaminace finálního textu.
- Mobilní uživatel (primární scénáře): stejný výsledek jako na desktopu v touch-safe režimu.

**Měřítka úspěchu (MVP):**
- 0 reprodukovatelných případů „comment leak“ do plain textu na produkčním build pipeline (release gate).
- ≥ 90 % klíčových desktop scénářů má ekvivalentní výsledek na mobilech.
- Zkrácení času k první smysluplné editaci (first meaningful edit) o min. 20 % u uživatelů používajících slash/selection workflow.

---

## 2) User Stories

### Persona A: Autor obsahu
1. **Jako autor** chci otevřít slash menu a rychle vložit blok, **abych** nemusel přerušovat psaní.
2. **Jako autor** chci při výběru textu vidět omezené menu s relevantními akcemi, **abych** neřešil zbytečné volby.
3. **Jako autor** chci použít AI instrukci nad vybraným textem nebo blokem, **abych** urychlil přeformulování.
4. **Jako autor** chci vybrat více bloků a spustit akci nad celým výběrem, **abych** upravoval dávkově.
5. **Jako autor** chci konzistentní light/dark UI, **abych** měl čitelný editor v každém prostředí.

### Persona B: Reviewer/editor
1. **Jako reviewer** chci přidávat komentáře bez rizika změny plain textu, **abych** zachoval integritu dokumentu.
2. **Jako reviewer** chci, aby metadata komentářů byla oddělená od obsahu, **aby** export/obsah neobsahoval interní poznámky.
3. **Jako reviewer** chci jasný undo tok po AI zásahu, **abych** mohl bezpečně vrátit změny.

### Persona C: Mobilní uživatel
1. **Jako mobilní uživatel** chci otevřít slash menu a vybrat blok dotykem, **abych** dosáhl stejného výsledku jako na desktopu.
2. **Jako mobilní uživatel** chci použít selection menu bez kolize s nativními touch gesty, **aby** byla editace spolehlivá.
3. **Jako mobilní uživatel** chci AI popup v kompaktním formátu s potvrzením změny, **aby** nedošlo k nechtěným přepisům.

---

## 3) Feature list s MoSCoW prioritizací

### Must Have (MVP)
1. **P1 oprava: comment leak fix** + striktní separace content/metadata.
2. **Slash menu** (desktop + mobile), referenční UX vzor, sjednocené vizuální styly.
3. **Omezené selection menu** při výběru textu (jen definované akce).
4. **AI instrukční mini-okno** pro vybraný text/blok: preview, confirm, undo.
5. **Multi-block baseline**: výběr více bloků + minimálně 1 společná akce.
6. **Light/Dark toggle** s jednotným style systémem pro všechny nové prvky.
7. **Outcome parity baseline desktop/mobile** pro výše uvedené toky.

### Should Have
1. Zkratky a rychlé klávesové ovládání pro slash/selection akce (desktop).
2. Lepší rankování slash položek dle posledního použití.

### Could Have
1. AI šablony instrukcí („zkrátit“, „změnit tón“, „vytáhnout body“).
2. Rozšířené multi-block operace (přesun, hromadné formátování).

### Won’t Have (tato verze)
1. Volné AI generování bez explicitního potvrzení uživatelem.
2. Plná desktopová feature parity na úrovni všech pokročilých gesture/shortcut detailů.
3. Komplexní komentářový systém redesign mimo nutné oddělení metadat.

---

## 4) Non-goals
- Nenahrazujeme celý editor novýmm enginem.
- Neřešíme kolaboraci v reálném čase (multi-user concurrency).
- Nezavádíme nový AI model ani backend orchestraci mimo potřebný kontrakt pro popup workflow.
- Neřešíme offline-first synchronizaci.

---

## 5) Technické a produktové constraints
- **Důvěra jako release gate:** P1 bug je blocker, bez jeho uzavření release neproběhne.
- **Strict content/metadata separation:** komentáře musí být uloženy a renderovány odděleně od plain text obsahu.
- **Parity constraint:** desktop a mobile musí dávat stejný výstup dokumentu pro stejné akce.
- **Touch-safe mobile model:** UI prvky nesmí kolidovat s nativní selekcí textu a základními gesty.
- **Controlled AI:** žádné automatické přepsání bez preview a explicitního confirm.

---

## 6) Acceptance Criteria (implementation-ready)

### 6.1 Kritická P1 oprava: Comment never pollutes plain text (Release Blocker)
1. Přidání/úprava/smazání komentáře nikdy nezmění plain text dokumentu.
2. Export plain text (a interní serializace obsahu) neobsahuje žádné komentářové markupy/metadatové tokeny.
3. Undo/redo komentářových akcí nemění textové uzly obsahu mimo explicitní textové editace uživatele.
4. Při AI úpravě textu zůstávají komentáře metadata-kanálem; žádný komentář se nepromítne do textu.
5. Test matrix (desktop + mobile) pokrývá create/edit/delete comment, copy/paste, multi-block, AI confirm/undo.

### 6.2 Slash menu
**Desktop:**
- Psaní `/` otevře menu do 150 ms, lze navigovat klávesnicí i myší.
- Výběr položky vloží očekávaný blok na aktuální pozici kurzoru.

**Mobile:**
- Psaní `/` otevře touch-optimal menu bez překrytí aktivního pole.
- Výběr položky dotykem vloží stejný typ bloku jako desktop.

### 6.3 Omezené selection menu
**Desktop:**
- Při výběru textu se zobrazí jen schválené akce (např. formátování, AI).
- Menu se zavře při zrušení výběru nebo ztrátě fokusu.

**Mobile:**
- Menu respektuje nativní text handles, nebrání úpravě výběru.
- Akce mají minimální touch target 44px.

### 6.4 AI mini-okno (selected text/block)
**Desktop:**
- Po volbě AI akce se otevře mini-okno s instrukcí a náhledem diff/result.
- Změna se aplikuje až po explicitním „Potvrdit“.
- „Zpět“ vrátí poslední AI aplikaci jedním krokem.

**Mobile:**
- Kompaktní modal/sheet varianta, zachová preview + confirm + undo.
- Nedochází k nechtěné aplikaci při tap-outside.

### 6.5 Multi-block baseline
**Desktop:**
- Uživatel označí více bloků (shift/click nebo ekvivalent) a spustí minimálně 1 společnou akci.

**Mobile:**
- Touch-safe výběr více bloků (např. přes režim „vybrat bloky“) se stejným výsledkem akce jako desktop.

### 6.6 Light/Dark toggle
**Desktop + Mobile:**
- Všechny nové UI prvky (slash, selection menu, AI popup) respektují aktivní téma.
- Kontrast textu a aktivních stavů splňuje interní přístupnostní limity.

---

## 7) Metriky (produkt + kvalita)

### Trust & correctness
- **Leak Defect Rate:** počet validních incidentů „comment leak do plain text“ = 0 (hard gate).
- **Regression Pass Rate:** 100 % testů v sadě content/metadata separation před releasem.

### Adoption & speed
- **Slash adoption:** % edit sessions se spuštěním slash menu (cílově +30 % proti baseline).
- **AI confirmed actions:** poměr confirm ku otevření AI popup (indikátor relevance).
- **Time to first meaningful edit:** median čas od otevření dokumentu k první dokončené akci (cílově -20 %).

### Parity
- **Outcome parity score:** % referenčních scénářů s identickým výsledkem dokumentu desktop vs mobile (cílově ≥90 % v MVP scope).
- **Deterministický parity gate (CI):** fixture matrix pro `slash`, `selection scope`, `AI confirm/undo` + malformed/boundary vstupy musí vyprodukovat `test-results/parity-gate.json` s `pass=true`, `parityScore >= 0.90` a reprodukovatelným výsledkem lokálně i v CI.

---

## 8) Open Questions
1. Jaký je minimální seznam akcí v „omezeném selection menu“ pro MVP (finální whitelist)?
2. Jaká forma diff preview je požadována pro AI (inline vs before/after panel)?
3. Jak přesně definovat mobile multi-block gesture pro nejnižší chybovost?
4. Má být theme toggle globální preference účtu nebo per-device?

---

## 9) MVP Definition
MVP je splněno, pokud je uzavřen P1 comment-leak bug (s automatizovanými regresními testy), a uživatel na desktopu i mobile zvládne: vložit blok přes slash, použít omezené menu výběru, aplikovat AI změnu přes preview+confirm+undo, a provést baseline multi-block akci v konzistentním light/dark UI. Tento rozsah musí validovat hypotézu „Trust first + faster creation + desktop/mobile outcome parity“ během prvního release cyklu.

---

## 10) Rollout plán
1. **Phase 0 – Safety gate (interní):** doručit P1 fix + regression suite + telemetry pro leak guard.
2. **Phase 1 – Desktop MVP:** slash + selection menu + AI popup + multi-block baseline + theme unification.
3. **Phase 2 – Mobile parity baseline:** touch-safe implementace stejných toků + parity test pass.
4. **Phase 3 – Controlled release:** feature flag rollout (interní → beta cohorta → 100 %), monitor metrik trust/parity/adoption.

**Release gate podmínky:**
- 0 kritických leak defektů v pre-release testech.
- Parity scénáře splněny v definovaném MVP rozsahu.
- AI popup má potvrzené undo a žádnou auto-aplikaci bez confirm.

---

## 11) Rizika a mitigace
1. **Riziko:** Skrytá vazba komentářů na textový model může způsobit regresi.
   - **Mitigace:** Contract tests na serializaci, property-based testy pro transformace, povinné review datové vrstvy.

2. **Riziko:** Mobile UX kolize s nativní text selekcí.
   - **Mitigace:** Oddělený „selection mode“ pro bloky, testy na cílových zařízeních, UX fallback.

3. **Riziko:** AI workflow zvýší kognitivní zátěž a zpomalí editaci.
   - **Mitigace:** Minimalistické UI, předvyplněné instrukce, měření conversion/funnel a rychlá iterace.

4. **Riziko:** Rozdíly desktop/mobile povedou k nekonzistentním výsledkům dokumentu.
   - **Mitigace:** Sdílené doménové transformace, parity test harness nad stejnými fixtures.

5. **Riziko:** Scope creep mimo MVP (rozšiřování menu/AI funkcí).
   - **Mitigace:** Striktní MVP backlog a explicitní „Won’t Have“ pro tuto verzi.
