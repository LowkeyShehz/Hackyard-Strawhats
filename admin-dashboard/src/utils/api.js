/**
 * Centralized fetch wrapper with JWT auth headers and silent token refresh.
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

// The backend rotates refresh tokens, so concurrent 401s must share one refresh call;
// a second call with the same (now revoked) token would fail and log the user out.
let refreshInFlight = null;

function refreshAccessToken() {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function doRefresh() {
  const refreshToken = localStorage.getItem('refreshToken');
  if (!refreshToken) return null;

  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    localStorage.setItem('accessToken', data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    return data.accessToken;
  } catch {
    return null;
  }
}

async function request(url, options = {}) {
  const accessToken = localStorage.getItem('accessToken');
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  let res = await fetch(`${API_BASE_URL}${url}`, { ...options, headers });

  // On 401, attempt silent refresh
  if (res.status === 401 && accessToken) {
    // If another request already refreshed while this one was in flight, reuse its token
    const storedToken = localStorage.getItem('accessToken');
    const newToken = storedToken && storedToken !== accessToken
      ? storedToken
      : await refreshAccessToken();
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`;
      res = await fetch(`${API_BASE_URL}${url}`, { ...options, headers });
    } else {
      // Refresh failed — clear tokens and redirect to login
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('admin');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
  }

  return res;
}

const api = {
  get(url) {
    return request(url, { method: 'GET' });
  },
  post(url, body) {
    return request(url, { method: 'POST', body: JSON.stringify(body) });
  },
  put(url, body) {
    return request(url, { method: 'PUT', body: JSON.stringify(body) });
  },
  delete(url) {
    return request(url, { method: 'DELETE' });
  },
};

export default api;
