/**
 * The front door. Shown when `GET /api/me` answers 401: a password box that posts to
 * `/api/login`, which hands back the session cookie every later request (and the socket)
 * carries on its own. On success the box removes itself and the caller boots the app.
 */
export function openLoginPanel(host: HTMLElement, onSuccess: () => void): void {
  const screen = document.createElement('div');
  screen.className = 'login';

  const panel = document.createElement('div');
  panel.className = 'login__box';
  screen.appendChild(panel);

  const heading = document.createElement('h2');
  heading.textContent = 'Locked';

  const hint = document.createElement('p');
  hint.className = 'login__hint';
  hint.textContent = 'AgentHub is closed to visitors.';

  const form = document.createElement('form');
  form.className = 'chat__form';
  const input = document.createElement('input');
  input.type = 'password';
  input.placeholder = 'Password';
  input.autocomplete = 'current-password';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Enter';
  form.append(input, submit);

  const error = document.createElement('p');
  error.className = 'login__error';
  error.hidden = true;

  panel.append(heading, hint, form, error);
  host.appendChild(screen);
  input.focus();

  /** Back to a usable box with the reason on it; the field is cleared rather than left to be edited. */
  const refuse = (message: string): void => {
    error.textContent = message;
    error.hidden = false;
    input.disabled = false;
    submit.disabled = false;
    input.value = '';
    input.focus();
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!input.value) return;
    input.disabled = true;
    submit.disabled = true;
    error.hidden = true;
    void fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
    })
      .then((response) => {
        if (!response.ok) {
          refuse(response.status === 401 ? 'Wrong password.' : `Hub replied ${response.status}.`);
          return;
        }
        screen.remove();
        onSuccess();
      })
      .catch(() => refuse('Hub unreachable.'));
  });
}
