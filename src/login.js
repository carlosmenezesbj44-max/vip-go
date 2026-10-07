import { setupPasswordVisibility } from './password-visibility.js';

setupPasswordVisibility();

const form = document.getElementById('loginForm');
const errorNode = document.getElementById('loginError');
const tabs = [...document.querySelectorAll('.login-tab')];
let mode = 'login';

function setMode(nextMode) {
  mode = nextMode;
  const registering = mode === 'register';
  tabs.forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.getElementById('formEyebrow').textContent = registering ? 'JUNTE-SE À COMUNIDADE' : 'BEM-VINDO DE VOLTA';
  document.getElementById('formTitle').textContent = registering ? 'Crie sua conta' : 'Entre na sua conta';
  const name = document.getElementById('nameField');
  const code = document.getElementById('companyCodeField');
  name.hidden = !registering;
  code.hidden = !registering;
  name.querySelector('input').required = registering;
  form.elements.password.autocomplete = registering ? 'new-password' : 'current-password';
  const submit = document.getElementById('loginSubmit');
  submit.textContent = registering ? 'Criar conta' : 'Entrar';
  errorNode.hidden = true;
  errorNode.textContent = '';
}

tabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode)));

async function request(path, payload) {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Não foi possível acessar sua conta.');
  return data;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorNode.hidden = true;
  const fields = new FormData(form);
  const submit = document.getElementById('loginSubmit');
  submit.disabled = true;
  submit.textContent = mode === 'register' ? 'Criando sua conta…' : 'Entrando…';
  try {
    const { user } = await request(`/auth/${mode === 'register' ? 'register' : 'login'}`, {
      name: fields.get('name'),
      email: fields.get('email'),
      password: fields.get('password'),
      companyCode: fields.get('companyCode'),
    });
    const localActivities = JSON.parse(localStorage.getItem('vip-go-activities-v1') || '[]');
    if (Array.isArray(localActivities) && localActivities.length) {
      try {
        await request('/activities/sync', { activities: localActivities.map((activity) => ({ ...activity, route: [] })) });
      } catch { /* Keep sign-in available if older offline activities cannot be imported. */ }
    }
    const requested = new URLSearchParams(window.location.search).get('next') || '/';
    const destination = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';
    window.location.replace(destination);
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = mode === 'register' ? 'Criar conta' : 'Entrar';
  }
});

fetch('/api/auth/me', { credentials: 'same-origin' })
  .then((response) => response.json())
  .then(({ user }) => { if (user) window.location.replace('/'); })
  .catch(() => {});
