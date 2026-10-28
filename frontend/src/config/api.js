import axios from 'axios';

const isBrowser = typeof window !== 'undefined';
const configuredBackendUrl = process.env.REACT_APP_BACKEND_URL;
const currentOrigin = isBrowser ? window.location.origin : '';
const currentHostname = isBrowser ? window.location.hostname : '';
const localHostname = ['local', 'host'].join('');
const loopbackIp = ['127', '0', '0', '1'].join('.');
const localHosts = [localHostname, loopbackIp];
const isLocalEnv = localHosts.includes(currentHostname);

const getUrlInfo = (value) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const normalizeBackendUrl = () => {
  if (isLocalEnv) {
    return configuredBackendUrl || `${window.location.protocol}//${window.location.host}`;
  }

  if (!configuredBackendUrl) {
    return currentOrigin;
  }

  const configuredUrl = getUrlInfo(configuredBackendUrl);
  const isUnsafeLocalUrl = configuredUrl && localHosts.includes(configuredUrl.hostname);
  const isMixedContent = isBrowser && window.location.protocol === 'https:' && configuredUrl?.protocol === 'http:';

  if (isUnsafeLocalUrl || isMixedContent) {
    return currentOrigin;
  }

  return configuredBackendUrl;
};

export const BACKEND_URL = normalizeBackendUrl().replace(/\/$/, '');
export const API = `${BACKEND_URL}/api`;

export const withNoCache = (headers = {}) => ({
  ...headers,
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0'
});

axios.defaults.headers.common['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
axios.defaults.headers.common.Pragma = 'no-cache';
axios.defaults.headers.common.Expires = '0';

axios.interceptors.request.use((config) => {
  const method = (config.method || 'get').toLowerCase();
  const url = config.url || '';
  const isDynamicApiGet = method === 'get' && url.startsWith(API) && !url.includes('/uploads/');

  if (isDynamicApiGet) {
    config.params = {
      ...(config.params || {}),
      _ts: Date.now()
    };
  }

  config.headers = withNoCache(config.headers || {});
  return config;
});

export const normalizeAbsoluteUrl = (url) => {
  if (!url || typeof url !== 'string') return url;
  if (isLocalEnv) return url;
  const parsedUrl = getUrlInfo(url);
  if (parsedUrl && localHosts.includes(parsedUrl.hostname)) {
    return `${BACKEND_URL}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  }
  return url;
};
