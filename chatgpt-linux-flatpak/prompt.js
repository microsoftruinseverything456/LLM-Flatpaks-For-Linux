// prompt.js — UI logic for the native window.prompt() modal.
(function () {
  var api = window.llPromptAPI || { token: '', message: '', def: '', done: function () {} };

  var msgEl = document.getElementById('msg');
  var input = document.getElementById('val');
  var okBtn = document.getElementById('ok');
  var cancelBtn = document.getElementById('cancel');

  msgEl.textContent = api.message;
  input.value = api.def;

  var answered = false;
  function submit(value) {
    if (answered) return;
    answered = true;
    api.done(api.token, value);
  }

  okBtn.addEventListener('click', function () { submit(input.value); });
  cancelBtn.addEventListener('click', function () { submit(null); });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submit(input.value); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); submit(null); }
  });

  // If the window is closed some other way, main.js treats it as a cancel.
  window.addEventListener('focus', function () { input.focus(); });
  input.focus();
  input.select();
})();
