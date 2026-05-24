// Active navigation helper
document.addEventListener('DOMContentLoaded', () => {
  const currentPath = window.location.pathname;
  document.querySelectorAll('.nav-link').forEach(link => {
    const page = link.getAttribute('data-page');
    if (
      (page === 'dashboard' && currentPath === '/') ||
      (page === 'logs' && currentPath.startsWith('/logs'))
    ) {
      link.classList.add('active');
    }
  });

  // Init Route Account filters
  filterRouteAccounts();
});

// Modal Actions
function openModal(id) {
  const modal = document.getElementById(id);
  if (id === 'accountModal' && !document.getElementById('accountId').value) {
    document.getElementById('accountMsId').disabled = false;
    document.getElementById('accountToken').required = true;
  }
  if (modal) modal.classList.add('open');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('open');
    const form = modal.querySelector('form');
    if (form && id !== 'detailsModal') form.reset();
    if (id === 'accountModal') {
      document.getElementById('accountMsId').disabled = false;
      document.getElementById('accountToken').required = true;
    }
    if (id === 'routeModal') resetRouteDirectorySelects();
  }
}

// Group CRUD
async function saveGroup(event) {
  event.preventDefault();
  const id = document.getElementById('groupId').value;
  const name = document.getElementById('groupName').value;

  const url = id ? `/api/groups/${id}` : '/api/groups';
  const method = id ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) throw new Error(await res.text());
    window.location.reload();
  } catch (err) {
    alert('Ошибка сохранения группы: ' + err.message);
  }
}

function editGroup(id, name) {
  document.getElementById('groupId').value = id;
  document.getElementById('groupName').value = name;
  document.getElementById('groupModalTitle').innerText = 'Редактировать группу';
  openModal('groupModal');
}

async function deleteGroup(id) {
  if (!confirm('Вы уверены, что хотите удалить эту группу? Подключенные аккаунты останутся без группы.')) return;
  try {
    const res = await fetch(`/api/groups/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    window.location.reload();
  } catch (err) {
    alert('Ошибка удаления группы: ' + err.message);
  }
}

// Account CRUD
async function saveAccount(event) {
  event.preventDefault();
  const id = document.getElementById('accountId').value;
  const group_id = document.getElementById('accountGroup').value;
  const name = document.getElementById('accountName').value;
  const ms_account_id = document.getElementById('accountMsId').value;
  const api_token = document.getElementById('accountToken').value;

  const url = id ? `/api/accounts/${id}` : '/api/accounts';
  const method = id ? 'PUT' : 'POST';

  const body = { group_id, name };
  if (!id) {
    body.ms_account_id = ms_account_id;
    body.api_token = api_token;
  } else if (api_token) {
    body.api_token = api_token;
  }

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(await res.text());
    window.location.reload();
  } catch (err) {
    alert('Ошибка подключения аккаунта: ' + err.message);
  }
}

async function editAccount(id) {
  try {
    const res = await fetch('/api/accounts');
    const accounts = await res.json();
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;

    document.getElementById('accountId').value = acc.id;
    document.getElementById('accountGroup').value = acc.group_id || '';
    document.getElementById('accountName').value = acc.name;
    
    const msInput = document.getElementById('accountMsId');
    msInput.value = acc.ms_account_id;
    msInput.disabled = true;

    document.getElementById('accountToken').required = false;
    document.getElementById('accountToken').placeholder = 'Оставьте пустым, чтобы сохранить текущий токен';

    openModal('accountModal');
  } catch (err) {
    alert('Не удалось загрузить данные аккаунта: ' + err.message);
  }
}

async function deleteAccount(id) {
  if (!confirm('Вы уверены, что хотите удалить этот аккаунт? Все связанные маршруты будут также удалены.')) return;
  try {
    const res = await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    window.location.reload();
  } catch (err) {
    alert('Ошибка удаления аккаунта: ' + err.message);
  }
}

// Routes Matrix & Group Isolation Logic
function filterRouteAccounts() {
  const selectedGroupId = document.getElementById('routeGroupFilter').value;
  const srcSelect = document.getElementById('routeSource');
  const tgtSelect = document.getElementById('routeTarget');

  srcSelect.value = '';
  tgtSelect.value = '';
  resetRouteDirectorySelects();

  Array.from(srcSelect.options).forEach(opt => {
    if (opt.value === '') return;
    const group = opt.getAttribute('data-group');
    if (selectedGroupId && group === selectedGroupId) {
      opt.style.display = 'block';
    } else {
      opt.style.display = 'none';
    }
  });

  Array.from(tgtSelect.options).forEach(opt => {
    if (opt.value === '') return;
    const group = opt.getAttribute('data-group');
    if (selectedGroupId && group === selectedGroupId) {
      opt.style.display = 'block';
    } else {
      opt.style.display = 'none';
    }
  });
}

function resetSelect(selectId, placeholder) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = `<option value="">${placeholder}</option>`;
  select.disabled = true;
}

function resetRouteDirectorySelects() {
  resetSelect('routeAgentUuid', '— Сначала выберите аккаунт-отправитель —');
  resetSelect('routeTargetAgentUuid', '— Сначала выберите аккаунт-получатель —');
  resetSelect('routeOrgUuid', '— Сначала выберите аккаунт-получатель —');
  resetSelect('routeStoreUuid', '— Сначала выберите аккаунт-получатель —');
}

function fillDirectorySelect(selectId, rows, placeholder) {
  const select = document.getElementById(selectId);
  select.innerHTML = `<option value="">${placeholder}</option>`;
  rows
    .filter(row => !row.archived)
    .forEach(row => {
      const option = document.createElement('option');
      option.value = row.id;
      option.textContent = row.code ? `${row.name} (${row.code})` : row.name;
      select.appendChild(option);
    });
  select.disabled = false;
}

async function fetchDirectory(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Не удалось загрузить справочник МоегоСклада');
  }
  return res.json();
}

async function loadSourceCounterparties() {
  const accountId = document.getElementById('routeSource').value;
  resetSelect('routeAgentUuid', 'Загрузка контрагентов...');
  if (!accountId) {
    resetSelect('routeAgentUuid', '— Сначала выберите аккаунт-отправитель —');
    return;
  }

  try {
    const rows = await fetchDirectory(`/api/moysklad/accounts/${accountId}/counterparties`);
    fillDirectorySelect('routeAgentUuid', rows, '— Выберите контрагента-получателя —');
  } catch (err) {
    alert('Ошибка загрузки контрагентов: ' + err.message);
    resetSelect('routeAgentUuid', '— Ошибка загрузки —');
  }
}

async function loadTargetDirectories() {
  const accountId = document.getElementById('routeTarget').value;
  resetSelect('routeTargetAgentUuid', 'Загрузка контрагентов...');
  resetSelect('routeOrgUuid', 'Загрузка организаций...');
  resetSelect('routeStoreUuid', 'Загрузка складов...');
  if (!accountId) {
    resetSelect('routeTargetAgentUuid', '— Сначала выберите аккаунт-получатель —');
    resetSelect('routeOrgUuid', '— Сначала выберите аккаунт-получатель —');
    resetSelect('routeStoreUuid', '— Сначала выберите аккаунт-получатель —');
    return;
  }

  try {
    const [agents, organizations, stores] = await Promise.all([
      fetchDirectory(`/api/moysklad/accounts/${accountId}/counterparties`),
      fetchDirectory(`/api/moysklad/accounts/${accountId}/organizations`),
      fetchDirectory(`/api/moysklad/accounts/${accountId}/stores`)
    ]);

    fillDirectorySelect('routeTargetAgentUuid', agents, '— Выберите контрагента-поставщика —');
    fillDirectorySelect('routeOrgUuid', organizations, '— Выберите организацию —');
    fillDirectorySelect('routeStoreUuid', stores, '— Выберите склад —');
  } catch (err) {
    alert('Ошибка загрузки справочников получателя: ' + err.message);
    resetSelect('routeTargetAgentUuid', '— Ошибка загрузки —');
    resetSelect('routeOrgUuid', '— Ошибка загрузки —');
    resetSelect('routeStoreUuid', '— Ошибка загрузки —');
  }
}

async function saveRoute(event) {
  event.preventDefault();
  const source_account_id = document.getElementById('routeSource').value;
  const agent_uuid = document.getElementById('routeAgentUuid').value;
  const target_account_id = document.getElementById('routeTarget').value;
  const target_agent_uuid = document.getElementById('routeTargetAgentUuid').value;
  const target_organization_uuid = document.getElementById('routeOrgUuid').value;
  const target_store_uuid = document.getElementById('routeStoreUuid').value;

  if (source_account_id === target_account_id) {
    alert('Исходный и целевой аккаунты должны отличаться!');
    return;
  }

  try {
    const res = await fetch('/api/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_account_id,
        agent_uuid,
        target_account_id,
        target_agent_uuid,
        target_organization_uuid,
        target_store_uuid
      })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Ошибка при создании маршрута');
    }
    window.location.reload();
  } catch (err) {
    alert('Ошибка сохранения маршрута: ' + err.message);
  }
}

async function toggleRoute(id, isActive) {
  try {
    const res = await fetch(`/api/routes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: isActive })
    });
    if (!res.ok) throw new Error(await res.text());
    window.location.reload();
  } catch (err) {
    alert('Ошибка изменения статуса маршрута: ' + err.message);
  }
}

async function deleteRoute(id) {
  if (!confirm('Вы уверены, что хотите удалить этот маршрут?')) return;
  try {
    const res = await fetch(`/api/routes/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    window.location.reload();
  } catch (err) {
    alert('Ошибка удаления маршрута: ' + err.message);
  }
}

// Log Details Modal Viewer
function viewLogDetails(details) {
  const viewer = document.getElementById('jsonViewer');
  if (viewer) {
    let raw = details;
    if (typeof details === 'string') {
      try { raw = JSON.parse(details); } catch (e) {}
    }
    viewer.innerText = JSON.stringify(raw, null, 2);
    openModal('detailsModal');
  }
}
