import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import km from "./locales/km";

const STORAGE_KEY = "biz_language";

export function getStoredLanguage(): "en" | "km" {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "km" ? "km" : "en";
}

export function setStoredLanguage(lang: "en" | "km"): void {
  localStorage.setItem(STORAGE_KEY, lang);
  // Fire-and-forget: i18n.changeLanguage returns a Promise that resolves once
  // resources are ready. Await it via .then so subscribers that attached late
  // still get notified via our manual event dispatch.
  const apply = () => {
    try {
      window.dispatchEvent(new CustomEvent("biz-language-changed", { detail: lang }));
    } catch { /* noop — older webviews */ }
  };
  const p = i18n.changeLanguage(lang);
  if (p && typeof (p as Promise<unknown>).then === "function") {
    (p as Promise<unknown>).then(apply, apply);
  } else {
    apply();
  }
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      km: { translation: km },
    },
    lng: getStoredLanguage(),
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    react: {
      // Ensures components using useTranslation re-render on languageChanged
      // and on resource additions.
      bindI18n: "languageChanged loaded",
      bindI18nStore: "added removed",
      useSuspense: false,
    },
  });

export default i18n;
