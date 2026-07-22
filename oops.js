// oops.js — drop-in on-screen crash readout for mobile dev (no console needed).
//
// USAGE: put this as the VERY FIRST script in <head>, before anything else, so it
// catches errors in scripts that load after it:
//
//     <script src="/oops.js"></script>
//
// It then catches:
//   • uncaught errors (window 'error')         — normal throws, including in modules
//   • failed promises (window 'unhandledrejection')
//   • console.error(...)                        — so your own logs surface too
//
// A red panel slides down with the message + first few stack lines. Tap it to copy
// the whole thing to the clipboard; tap the × to dismiss. Toggle it from code with
// oops('your message') to log manually, or oops.hide().
//
// One gap it CAN'T cover: a hard syntax error in an ES module (type="module") still
// fails silently in some browsers because the module never executes. For those, wrap
// the module body in try{ }catch(e){ oops(e) } — that always works.

(function () {
  if (window.oops) return;
  var box, log = [];

  function ensure() {
    if (box) return box;
    box = document.createElement('div');
    box.style.cssText = [
      'position:fixed', 'left:6px', 'right:6px', 'top:6px', 'z-index:2147483647',
      'background:rgba(40,0,0,0.94)', 'border:1px solid #f55', 'border-radius:6px',
      'color:#ffd', 'font:12px/1.45 ui-monospace,Menlo,Consolas,monospace',
      'padding:9px 30px 9px 11px', 'white-space:pre-wrap', 'word-break:break-word',
      'max-height:60vh', 'overflow:auto', '-webkit-overflow-scrolling:touch',
      'box-shadow:0 4px 20px rgba(0,0,0,0.6)'
    ].join(';');
    box.title = 'tap to copy · × to dismiss';
    var x = document.createElement('button');
    x.textContent = '×';
    x.style.cssText = 'position:absolute;top:0;right:0;background:none;border:none;color:#f99;font-size:24px;line-height:1;cursor:pointer;padding:6px 12px;-webkit-tap-highlight-color:transparent';
    x.onclick = function (e) { e.stopPropagation(); hide(); };
    box.onclick = function () {
      var text = log.join('\n\n');
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(flash, flash);
      else flash();
    };
    box.appendChild(x);
    (document.body || document.documentElement).appendChild(box);
    return box;
  }
  function flash() { box.style.borderColor = '#5f5'; setTimeout(function () { if (box) box.style.borderColor = '#f55'; }, 250); }

  function render() {
    ensure();
    // reset the text, then re-add the × button
    box.textContent = log.join('\n\n');
    var x = document.createElement('button');
    x.textContent = '×';
    x.style.cssText = 'position:absolute;top:0;right:0;background:none;border:none;color:#f99;font-size:24px;line-height:1;cursor:pointer;padding:6px 12px;-webkit-tap-highlight-color:transparent';
    x.onclick = function (e) { e.stopPropagation(); hide(); };
    box.appendChild(x);
    box.style.display = 'block';
  }
  function hide() { if (box) box.style.display = 'none'; }

  function fmt(label, err) {
    var msg = err && err.message ? err.message : String(err);
    var stack = err && err.stack ? '\n' + err.stack.split('\n').slice(0, 5).join('\n') : '';
    return '[' + label + '] ' + msg + stack;
  }
  function add(label, err) {
    var line = fmt(label, err);
    if (log.length && log[log.length - 1] === line) return;   // dedupe: a stuck value spamming the same error won't keep re-popping a dismissed box
    log.push(line); if (log.length > 12) log.shift(); render();
  }

  window.addEventListener('error', function (ev) {
    // resource load failures (img/script 404) fire 'error' on the element with no ev.error
    if (ev.error) add('error', ev.error);
    else if (ev.message) add('error', ev.message + (ev.filename ? '  @ ' + ev.filename.split('/').pop() + ':' + ev.lineno : ''));
    else if (ev.target && ev.target.src) add('load-fail', (ev.target.tagName || '') + ' ' + ev.target.src);
  }, true);
  window.addEventListener('unhandledrejection', function (ev) { add('promise', ev.reason); });

  // surface console.error too (your own logs)
  var ce = console.error.bind(console);
  console.error = function () { try { add('log', Array.prototype.map.call(arguments, String).join(' ')); } catch (e) {} return ce.apply(null, arguments); };

  // manual logging: oops('msg') or oops(errorObject)
  window.oops = function (x) { add(typeof x === 'string' ? 'note' : 'caught', x); };
  window.oops.hide = hide;
  window.oops.clear = function () { log = []; hide(); };
})();
