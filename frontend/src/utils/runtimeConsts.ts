import mobile from 'is-mobile';

export const isMobile: boolean = mobile.isMobile();

export const browserVersion: string = (function () {
  let ua = navigator.userAgent, tem,
      M = ua.match(/(opera|chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)/i) || [];
  if (/trident/i.test(M[1])) {
    tem = /\brv[ :]+(\d+)/g.exec(ua) || [];

    return 'IE ' + (tem[1] || '');
  }
  if (M[1] === 'Chrome') {
    tem = ua.match(/\b(OPR|Edge)\/(\d+)/);
    if (tem != undefined) { return tem.slice(1).join(' ').replace('OPR', 'Opera'); }
  }
  M = M[2] ? [M[1], M[2]] : [navigator.appName, navigator.appVersion, '-?'];
  if ((tem = ua.match(/version\/(\d+)/i)) != undefined) { M.splice(1, 1, tem[1]); }

  return M.join(' ');
})() + (isMobile ? ' mobile' : '');
export const isFirefox = browserVersion.indexOf('Firefox') >= 0;
export const WEBRTC_STUNT_URL = isFirefox ? 'stun:23.21.150.121' : 'stun:stun.l.google.com:19302';
export const isChrome = browserVersion.indexOf('Chrome') >= 0;
