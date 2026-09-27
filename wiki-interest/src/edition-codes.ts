export type EditionGuess = { code: string; language: string };

// Country codes people type for an Edition, mapped to the Edition of that country's main language.
// Only codes that aren't Wikipedia language codes themselves: `se` (Northern Sami) or `si` (Sinhala) are real Editions.
const COUNTRY_CODES = new Map<string, EditionGuess>([
  ["ua", { code: "uk", language: "Ukrainian" }],
  ["by", { code: "be", language: "Belarusian" }],
  ["cz", { code: "cs", language: "Czech" }],
  ["gr", { code: "el", language: "Greek" }],
  ["dk", { code: "da", language: "Danish" }],
  ["jp", { code: "ja", language: "Japanese" }],
  ["kr", { code: "ko", language: "Korean" }],
  ["cn", { code: "zh", language: "Chinese" }],
  ["il", { code: "he", language: "Hebrew" }],
  ["rs", { code: "sr", language: "Serbian" }],
  ["kz", { code: "kk", language: "Kazakh" }],
  ["ir", { code: "fa", language: "Persian" }],
  ["vn", { code: "vi", language: "Vietnamese" }],
  ["at", { code: "de", language: "German" }],
  ["gb", { code: "en", language: "English" }],
  ["us", { code: "en", language: "English" }],
]);

export function languageForCountryCode(code: string): EditionGuess | undefined {
  return COUNTRY_CODES.get(code);
}
