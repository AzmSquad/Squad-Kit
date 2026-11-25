/** Small names and settings of the Android module, by themselves. */

/**
 * The environment without the person's own Android settings (ANDROID_SDK_HOME, ANDROID_SERIAL, …): squad-kit's calls
 * set their own, and one left from the person's could point a tool at their folders or their phone.
 */
export function withoutAndroid(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('ANDROID_')));
}

/** The locale tag that goes with a language: Arabic as in Saudi Arabia, English as in the United States. */
const LOCALES: Record<string, string> = { ar: 'ar-SA', en: 'en-US', fr: 'fr-FR', de: 'de-DE', es: 'es-ES', ur: 'ur-PK', tr: 'tr-TR' };

export function localeTag(language: string): string {
  const l = language.trim().toLowerCase().split(/[-_]/)[0] || 'en';
  return LOCALES[l] ?? `${l}-${l.toUpperCase()}`;
}

/** "squad-kit Android phone" as an AVD may be named: "squad-kit-android-phone". */
export function avdName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The image a system-images folder holds, as sdkmanager names it: "system-images;android-36;google_apis;arm64-v8a". */
export function imageId(api: number | string, tag: string, abi: string): string {
  return `system-images;android-${api};${tag};${abi}`;
}
