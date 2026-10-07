const eyeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2.2 12s3.4-6.8 9.8-6.8 9.8 6.8 9.8 6.8-3.4 6.8-9.8 6.8S2.2 12 2.2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const eyeOffIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m3 3 18 18M10.6 5.4c.5-.1.9-.2 1.4-.2 6.4 0 9.8 6.8 9.8 6.8a16 16 0 0 1-3.1 3.9M6.2 6.3C3.6 8 2.2 12 2.2 12s3.4 6.8 9.8 6.8c1.1 0 2.1-.2 3-.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

export function setupPasswordVisibility(root = document) {
  root.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.dataset.visibilityToggle === 'ready') return;
    input.dataset.visibilityToggle = 'ready';

    const control = document.createElement('span');
    control.className = 'password-field-control';
    input.before(control);
    control.append(input);

    const toggle = document.createElement('button');
    toggle.className = 'password-visibility-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Mostrar senha');
    toggle.setAttribute('aria-controls', input.id || '');
    toggle.setAttribute('aria-pressed', 'false');
    toggle.title = 'Mostrar senha';
    toggle.innerHTML = eyeIcon;
    control.append(toggle);

    toggle.addEventListener('click', () => {
      const showing = input.type === 'password';
      input.type = showing ? 'text' : 'password';
      toggle.setAttribute('aria-label', showing ? 'Ocultar senha' : 'Mostrar senha');
      toggle.setAttribute('aria-pressed', String(showing));
      toggle.title = showing ? 'Ocultar senha' : 'Mostrar senha';
      toggle.innerHTML = showing ? eyeOffIcon : eyeIcon;
      input.focus({ preventScroll: true });
    });
  });
}
