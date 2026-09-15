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
      "st.resetConfirm": "Reset shortcuts, font size, shell and start folder to the defaults?",
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
      "st.resetConfirm": "단축키·글자 크기·쉘·시작 폴더를 기본값으로 되돌릴까요?",
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
