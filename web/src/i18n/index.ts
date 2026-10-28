import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCommon from '../locales/zh-CN/common.json'
import enCommon from '../locales/en/common.json'
import zhSearch from '../locales/zh-CN/search.json'
import enSearch from '../locales/en/search.json'

const detected = navigator.language.startsWith('zh') ? 'zh-CN' : 'en'
const stored = localStorage.getItem('repotory-language')
const lng = stored === 'zh-CN' || stored === 'en' ? stored : detected

// The <html lang> attribute is the only thing that tells the browser — and a
// screen reader, and any built-in translation heuristic — which language is
// actually on screen. index.html ships lang="zh-CN", so without applying the
// resolved language at start-up an English user who stored their preference
// would reload into an English UI that still announces itself as Chinese.
function applyDocumentLang(language: string) {
  document.documentElement.lang = language === 'zh-CN' ? 'zh-CN' : 'en'
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { common: zhCommon, search: zhSearch },
      en:       { common: enCommon, search: enSearch },
    },
    lng,
    fallbackLng: 'en',
    ns: ['common', 'search'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })

applyDocumentLang(lng)

export function setLanguage(lng: string) {
  i18n.changeLanguage(lng)
  localStorage.setItem('repotory-language', lng)
  applyDocumentLang(lng)
  window.dispatchEvent(new Event('repotory-lang-change'))
}

export function getCurrentLanguage() {
  return i18n.language
}

export default i18n
