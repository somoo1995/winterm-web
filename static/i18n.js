/* UI language - English and Korean.
 *
 * The repository is English throughout, deliberately, because it is public. That is the right
 * default for the code and the wrong one for a user who does not read English, so the INTERFACE
 * gets a language while the source does not.
 *
 * English is the source of truth: `t()` falls back to it key by key, so a missing or half-finished
 * Korean entry shows English rather than a blank button. Adding a third language therefore means
 * adding a dictionary, not touching any call site.
 *
 * Static markup carries its key in an attribute (data-i18n / -title / -aria / -ph) so translating
 * the chrome is a DOM walk; only genuinely dynamic strings go through t() in app.js.
 *
 * NOT translated on purpose: terminal output (it belongs to the shell), pane and tab names (the
 * user's own words), action IDs like `pane.split.h` (they are config syntax, and translating them
 * would break every config file), and shell commands.
 */
(function () {
  "use strict";

  var STRINGS = {
    en: {
      // -- tab bar / chrome
      "chrome.allTabs": "All tabs and panes",
      "chrome.rail": "Collapse/expand the session rail (Alt+B)",
      "chrome.newTab": "New tab (Ctrl+T) - right-click to choose a folder",
      "chrome.install": "Install as an app on your home screen",
      "chrome.refit": "Refresh - fit to this screen and redraw",
      "chrome.kbToggle": "Collapse/expand the special-key bar",
      "chrome.settings": "Settings",
      "chrome.pageUp": "Page up",
      "chrome.pageDown": "Page down",
      "chrome.toBottom": "To the bottom",
      "chrome.close": "Close",
      "chrome.dismiss": "Dismiss",
      "chrome.compose": "Compose here",
      "chrome.drawerHead": "Tabs · Panes",

      // -- context menu
      "menu.splitH": "New pane - to the right (Ctrl+])",
      "menu.splitV": "New pane - below (Ctrl+\\)",
      "menu.zoom": "Toggle fullscreen for this pane (double-click - Alt+number)",
      "menu.renamePane": "Pane name (Ctrl+P)",
      "menu.renameTab": "Rename tab (Ctrl+T)",
      "menu.newHere": "New tab here",
      "menu.redraw": "Refresh - fit to this screen and redraw (Ctrl+Shift+R)",
      "menu.clear": "Clear the screen (clear)",
      "menu.webgl": "Sharpen (WebGL) on/off",
      "menu.close": "Close (Alt+X)",

      // -- settings panel
      "st.title": "Settings",
      "st.tab.keys": "Shortcuts",
      "st.tab.general": "General",
      "st.filter": "Filter shortcuts",
      "st.add": "Add",
      "st.keysNote": "Click a shortcut to record a new one. Leave an action empty to pass that key through to the terminal.",
      "st.language": "Language",
      "st.langAuto": "Automatic ({lang})",
      "st.fontSize": "Font size",
      "st.fontFamily": "Font",
      "st.fontFamilyPh": "empty = built-in (JetBrains Mono + Sarasa Fixed K)",
      "st.fontNote": "The font must be installed on the device you are looking at. A name that is not found falls back to the built-in font.",
      "st.fontNotFound": "saved · '{f}' was not found on this device, so the built-in font is drawing",
      "st.fontNotMono": "saved · '{f}' is not monospace - columns may misalign",
      "st.shell": "Shell",
      "st.shellCustom": "e.g. /bin/zsh -l",
      "st.startFolder": "Start folder",
      "st.startFolderPh": "empty = home",
      "st.termNote": "Shell and start folder apply to newly opened panes.",
      "st.reset": "Reset to defaults",
      "st.save": "Save",
      "st.saving": "saving...",
      "st.saved": "saved",
      "st.resetting": "resetting...",
      "st.resetDone": "reset to defaults",
      "st.resetConfirm": "Reset shortcuts, font, font size, shell and start folder to the defaults?",
      "st.loadFailed": "could not load settings",
      "st.pressKey": "press a key...",
      "st.passThrough": "(pass to terminal)",
      "st.custom": "Custom...",
      "st.defaultFor": "Default for {platform}",
      "st.dupWarn": "duplicate shortcut - only the last one would survive",
      "st.reservedWarn": "the browser takes this one first - it will never reach webterm",
      "st.noMatch": "Nothing matches that filter.",
      "st.argTitle": "argument (e.g. pane number)",

      // -- stale-code banner
      "stale.reload": "Reload",
      "stale.how": "How?",
      "stale.restart": "Restart web server",
      "stale.restarting": "restarting the web server... (your shells stay open)",
      "stale.update": "webterm {remote} is available (you have {local}). Updating replaces the files; the web server is then restarted with your shells kept.",
      "stale.updateBtn": "Update",
      "stale.updating": "updating... downloading and copying files (10-30s)",
      "stale.failed": "That did not work. See webterm.log / update.log.",
      "stale.daemonConfirm": "Restart the session daemon?\n\nTHIS CLOSES EVERY SHELL - {n} session(s) are alive right now, including anything running in them (claude, builds, servers).\n\nFinish what you are doing in the open panes first. Continue?",
      "st.upd.title": "Version",
      "st.upd.check": "Check now",
      "st.upd.update": "Update",
      "st.upd.server": "Restart web server",
      "st.upd.daemon": "Restart daemon (closes all shells)",
      "st.upd.checking": "checking GitHub...",
      "st.upd.dev": "\n(developer checkout - update with git; no update button here)",
      "st.upd.upToDate": "Your version: {local}\nLatest: {remote} - up to date\nchecked {when}",
      "st.upd.available": "Your version: {local}\nLatest: {remote} - a new version is available\nchecked {when}",
      "st.upd.unknown": "Your version: {local}\nLatest: not known yet ({err})",
      "st.upd.stale": "\nOn disk but not yet running: {what}. Restart it to finish.",
      "st.upd.started": "started - the banner at the top follows the progress",
      "stale.serverHelp": "Restart the web server:\n\n  Windows:  webterm.exe --restart\n  macOS/Linux:  Ctrl+C in the terminal running server.py, then run it again\n\nYour open shells are held by the session daemon and will survive.",
      "stale.daemonHelp": "Restart the session daemon - THIS CLOSES EVERY SHELL:\n\n  Windows:  webterm.exe --stop-all, then webterm.exe\n  macOS/Linux:  pkill -f 'daemon.py', then run server.py again\n\nFinish what you are doing in the open panes first.",

      // -- prompts and messages
      "msg.noPane": "no pane",
      "msg.uploading": "uploading {n}...",
      "msg.uploaded": "uploaded {n} {size}",
      "msg.uploadFailed": "upload failed",
      "msg.clipEmpty": "clipboard is empty",
      "msg.pasteFailed": "paste failed",
      "msg.closePane": "Close a pane of '{name}'?",
      "msg.closeTab": "Close tab '{name}'?",
      "msg.closeTabPanes": "Close tab '{name}' ({n} panes)?",
      "msg.paneName": "Pane name (#{n} · empty = auto)",
      "msg.tabName": "Tab name",
      "msg.renameFailed": "could not rename",
      "msg.movePane": "Move pane #{n} to which tab?",
      "msg.moveHint": "1-9 or ↑↓ + Enter to choose · Esc to cancel",
      "msg.movePaneCount": "{n} panes",
      "msg.moveAlone": "There is no other tab to move this pane to.",
      "msg.moveFailed": "could not move the pane",
      "msg.moved": "moved to '{name}'",
      "msg.moveLabelCleared": "moved to '{name}' · the pane name was in use there, so it went back to automatic",
      "msg.hideTitle": "Hide this pane, or bring a hidden one here",
      "msg.hideThis": "Hide this pane",
      "msg.hideHidden": "hidden",
      "msg.hideNothing": "Nothing to hide or bring back.",
      "msg.hideLast": "This is the only pane on screen - hiding it would leave nothing.",
      "msg.hideDone": "hidden · {n} hidden in total (Ctrl+H brings them back)",
      "msg.hideBack": "brought into '{name}'",
      "msg.renameTabFailed": "could not rename the tab",
      "msg.fitToScreen": "fit to screen {c}x{r}",
      "msg.newTabCwd": "Starting folder for the new tab",
      "msg.dragHint": "drag to select/copy · release for menu",
      "msg.nothingSelected": "nothing selected",
      "msg.copied": "copied {n} chars",
    },

    ko: {
      "chrome.allTabs": "전체 탭·패널",
      "chrome.rail": "세로 세션 목록 접기/펼치기 (Alt+B)",
      "chrome.newTab": "새 탭 (Ctrl+T) - 우클릭하면 폴더 선택",
      "chrome.install": "앱으로 설치하기",
      "chrome.refit": "새로고침 - 화면에 맞추고 다시 그리기",
      "chrome.kbToggle": "특수키 바 접기/펼치기",
      "chrome.settings": "설정",
      "chrome.pageUp": "위로",
      "chrome.pageDown": "아래로",
      "chrome.toBottom": "맨 아래로",
      "chrome.close": "닫기",
      "chrome.dismiss": "닫기",
      "chrome.compose": "여기에 입력",
      "chrome.drawerHead": "탭 · 패널",

      "menu.splitH": "새 패널 - 오른쪽 (Ctrl+])",
      "menu.splitV": "새 패널 - 아래 (Ctrl+\\)",
      "menu.zoom": "이 패널 전체화면 토글 (더블클릭 - Alt+숫자)",
      "menu.renamePane": "패널 이름 (Ctrl+P)",
      "menu.renameTab": "탭 이름 변경 (Ctrl+T)",
      "menu.newHere": "이 폴더에서 새 탭",
      "menu.redraw": "새로고침 - 화면에 맞추고 다시 그리기 (Ctrl+Shift+R)",
      "menu.clear": "화면 지우기 (clear)",
      "menu.webgl": "선명하게 (WebGL) 켜기/끄기",
      "menu.close": "닫기 (Alt+X)",

      "st.title": "설정",
      "st.tab.keys": "단축키",
      "st.tab.general": "일반",
      "st.filter": "단축키 검색",
      "st.add": "추가",
      "st.keysNote": "단축키를 클릭한 뒤 원하는 키를 누르면 기록됩니다. 동작을 비워두면 그 키는 터미널로 그대로 전달됩니다.",
      "st.language": "언어",
      "st.langAuto": "자동 ({lang})",
      "st.fontSize": "글자 크기",
      "st.fontFamily": "글꼴",
      "st.fontFamilyPh": "비우면 내장 글꼴 (JetBrains Mono + Sarasa Fixed K)",
      "st.fontNote": "글꼴은 지금 보고 있는 기기에 설치돼 있어야 합니다. 없는 이름이면 내장 글꼴로 그립니다.",
      "st.fontNotFound": "저장됨 · '{f}' 글꼴이 이 기기에 없어 내장 글꼴로 그리고 있습니다",
      "st.fontNotMono": "저장됨 · '{f}' 은(는) 고정폭이 아니라 글자가 어긋날 수 있습니다",
      "st.shell": "쉘",
      "st.shellCustom": "예: /bin/zsh -l",
      "st.startFolder": "시작 폴더",
      "st.startFolderPh": "비우면 홈 디렉터리",
      "st.termNote": "쉘과 시작 폴더는 새로 여는 패널부터 적용됩니다.",
      "st.reset": "기본값으로",
      "st.save": "저장",
      "st.saving": "저장 중...",
      "st.saved": "저장됨",
      "st.resetting": "초기화 중...",
      "st.resetDone": "기본값으로 돌림",
      "st.resetConfirm": "단축키·글꼴·글자 크기·쉘·시작 폴더를 기본값으로 되돌릴까요?",
      "st.loadFailed": "설정을 불러오지 못했습니다",
      "st.pressKey": "키를 누르세요...",
      "st.passThrough": "(터미널로 전달)",
      "st.custom": "직접 입력...",
      "st.defaultFor": "{platform} 기본값",
      "st.dupWarn": "중복된 단축키 - 마지막 항목만 남습니다",
      "st.reservedWarn": "브라우저가 먼저 가로채는 키라 webterm 까지 오지 않습니다",
      "st.noMatch": "검색 결과가 없습니다.",
      "st.argTitle": "인자 (예: 패널 번호)",

      "stale.reload": "새로고침",
      "stale.how": "어떻게?",
      "stale.restart": "웹서버 재시작",
      "stale.restarting": "웹서버를 재시작하는 중... (열린 쉘은 유지됩니다)",
      "stale.update": "webterm {remote} 버전이 나왔습니다 (내 버전 {local}). 업데이트하면 파일을 교체한 뒤 웹서버만 재시작합니다 (쉘 유지).",
      "stale.updateBtn": "업데이트",
      "stale.updating": "업데이트 중... 파일을 내려받아 복사하고 있습니다 (10~30초)",
      "stale.failed": "실패했습니다. webterm.log / update.log 를 확인하세요.",
      "stale.daemonConfirm": "세션 데몬을 재시작할까요?\n\n열려 있는 쉘이 전부 종료됩니다 - 지금 {n}개 세션이 살아 있고, 그 안에서 도는 것(claude·빌드·서버)도 함께 끝납니다.\n\n열린 패널의 작업을 먼저 마무리하세요. 계속할까요?",
      "st.upd.title": "버전",
      "st.upd.check": "지금 확인",
      "st.upd.update": "업데이트",
      "st.upd.server": "웹서버 재시작",
      "st.upd.daemon": "데몬 재시작 (쉘 전부 종료)",
      "st.upd.checking": "GitHub 확인 중...",
      "st.upd.dev": "\n(개발용 체크아웃 - 업데이트는 git 으로 합니다. 여기엔 업데이트 버튼이 없습니다)",
      "st.upd.upToDate": "내 버전: {local}\n최신 버전: {remote} - 최신입니다\n확인 시각 {when}",
      "st.upd.available": "내 버전: {local}\n최신 버전: {remote} - 새 버전이 있습니다\n확인 시각 {when}",
      "st.upd.unknown": "내 버전: {local}\n최신 버전: 아직 확인 못 함 ({err})",
      "st.upd.stale": "\n디스크에는 있지만 아직 실행되지 않은 것: {what}. 재시작하면 끝납니다.",
      "st.upd.started": "시작했습니다 - 위쪽 배너가 진행을 보여줍니다",
      "stale.serverHelp": "웹서버를 재시작하세요:\n\n  Windows:  webterm.exe --restart\n  macOS/Linux:  server.py 를 돌리는 터미널에서 Ctrl+C 후 다시 실행\n\n열려 있는 쉘은 세션 데몬이 들고 있어서 그대로 살아남습니다.",
      "stale.daemonHelp": "세션 데몬을 재시작해야 합니다 - 열려있는 쉘이 전부 종료됩니다:\n\n  Windows:  webterm.exe --stop-all 후 webterm.exe\n  macOS/Linux:  pkill -f 'daemon.py' 후 server.py 다시 실행\n\n열려 있는 패널의 작업을 먼저 마무리하세요.",

      "msg.noPane": "패널 없음",
      "msg.uploading": "업로드 중 {n}개...",
      "msg.uploaded": "{n}개 업로드됨 {size}",
      "msg.uploadFailed": "업로드 실패",
      "msg.clipEmpty": "클립보드가 비어있습니다",
      "msg.pasteFailed": "붙여넣기 실패",
      "msg.closePane": "'{name}' 의 패널 하나를 닫을까요?",
      "msg.closeTab": "'{name}' 탭을 닫을까요?",
      "msg.closeTabPanes": "'{name}' 탭을 닫을까요? (패널 {n}개)",
      "msg.paneName": "패널 이름 (#{n} · 비우면 자동)",
      "msg.tabName": "탭 이름",
      "msg.renameFailed": "이름을 바꿀 수 없습니다",
      "msg.movePane": "{n}번 패널을 어느 탭으로 옮길까요?",
      "msg.moveHint": "1~9 또는 ↑↓ + Enter 로 선택 · Esc 취소",
      "msg.movePaneCount": "패널 {n}개",
      "msg.moveAlone": "옮길 다른 탭이 없습니다.",
      "msg.moveFailed": "패널을 옮기지 못했습니다",
      "msg.moved": "'{name}' 탭으로 옮겼습니다",
      "msg.moveLabelCleared": "'{name}' 탭으로 옮겼습니다 · 그 탭에 같은 패널 이름이 있어 자동 이름으로 되돌렸습니다",
      "msg.hideTitle": "패널을 숨기거나, 숨긴 패널을 여기로 가져옵니다",
      "msg.hideThis": "이 패널 숨기기",
      "msg.hideHidden": "숨김",
      "msg.hideNothing": "숨기거나 꺼낼 패널이 없습니다.",
      "msg.hideLast": "화면에 이 패널 하나뿐입니다 - 숨기면 볼 것이 없어집니다.",
      "msg.hideDone": "숨겼습니다 · 모두 {n}개 (Ctrl+H 로 다시 꺼냅니다)",
      "msg.hideBack": "'{name}' 탭으로 가져왔습니다",
      "msg.renameTabFailed": "탭 이름을 바꿀 수 없습니다",
      "msg.fitToScreen": "화면에 맞춤 {c}x{r}",
      "msg.newTabCwd": "새 탭을 열 폴더",
      "msg.dragHint": "드래그해서 선택·복사 · 떼면 메뉴",
      "msg.nothingSelected": "선택된 것이 없습니다",
      "msg.copied": "{n}자 복사됨",
    },
  };

  var LANGS = [
    { code: "en", label: "English" },
    { code: "ko", label: "한국어" },
  ];

  var current = "en";

  // An unset language follows the browser rather than defaulting to English: the person who needs
  // Korean is the least likely to go looking for a setting written in English.
  function resolve(pref) {
    if (pref && STRINGS[pref]) return pref;
    var nav = (navigator.language || "").toLowerCase();
    return nav.indexOf("ko") === 0 ? "ko" : "en";
  }

  function t(key, params) {
    var s = STRINGS[current][key];
    if (s === undefined) s = STRINGS.en[key];      // English is the fallback, key by key
    if (s === undefined) return key;               // never render blank - show the key instead
    if (params) {
      for (var k in params) {
        s = s.split("{" + k + "}").join(params[k]);
      }
    }
    return s;
  }

  // Walk the markup and fill in anything tagged with a key.
  function applyDom(root) {
    root = root || document;
    root.querySelectorAll("[data-i18n]").forEach(function (el) {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    root.querySelectorAll("[data-i18n-title]").forEach(function (el) {
      el.title = t(el.getAttribute("data-i18n-title"));
    });
    root.querySelectorAll("[data-i18n-aria]").forEach(function (el) {
      el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
    });
    root.querySelectorAll("[data-i18n-ph]").forEach(function (el) {
      var s = t(el.getAttribute("data-i18n-ph"));
      if ("placeholder" in el) el.placeholder = s;
      else el.setAttribute("data-ph", s);           // the compose box draws its own placeholder
    });
  }

  function setLang(pref) {
    current = resolve(pref);
    document.documentElement.lang = current;
    applyDom();
  }

  window.i18n = {
    t: t,
    setLang: setLang,
    apply: applyDom,
    langs: LANGS,
    current: function () { return current; },
    autoLabel: function () { return resolve("") === "ko" ? "한국어" : "English"; },
  };
})();
