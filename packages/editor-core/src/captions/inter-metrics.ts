// Inter 4.001 advance widths for the burn-in weights — deterministic line
// breaking in node and the browser without a text shaper.
//
// Table generation (tooling not vendored): static instances at opsz=14 via
// `fonttools varLib.instancer inter.ttf wght=<600|700|800> opsz=14
// --update-name-table`, then `hmtx[cmap[cp]][0]` for cp in U+0020..U+007E.
// Values are font units; divide by unitsPerEm (2048) for em.

export type CaptionFontWeight = 600 | 700 | 800

const UNITS_PER_EM = 2048
const ASCII_FIRST = 0x20
const ASCII_LAST = 0x7e

const INTER_ADVANCES: Record<CaptionFontWeight, readonly number[]> = {
  600: [
    516, 658, 1071, 1318, 1332, 2057, 1357, 667, 764, 764, 1105, 1378, 653, 953, 653, 776, 1351,
    866, 1276, 1303, 1364, 1254, 1310, 1180, 1311, 1310, 653, 674, 1378, 1378, 1378, 1113, 2046,
    1490, 1350, 1509, 1479, 1240, 1204, 1534, 1527, 567, 1187, 1440, 1158, 1889, 1555, 1574, 1321,
    1583, 1336, 1332, 1352, 1507, 1490, 2089, 1474, 1461, 1336, 764, 776, 764, 986, 961, 719, 1176,
    1278, 1193, 1278, 1211, 796, 1281, 1254, 536, 536, 1166, 536, 1844, 1253, 1247, 1278, 1278, 813,
    1125, 723, 1254, 1202, 1719, 1165, 1205, 1159, 931, 735, 931, 1378,
  ],
  700: [
    485, 692, 1129, 1329, 1341, 2080, 1376, 694, 772, 772, 1145, 1390, 684, 958, 684, 795, 1381,
    883, 1289, 1322, 1385, 1274, 1330, 1191, 1333, 1330, 684, 702, 1390, 1390, 1390, 1146, 2081,
    1529, 1355, 1515, 1479, 1244, 1202, 1537, 1530, 575, 1197, 1473, 1158, 1908, 1561, 1578, 1327,
    1591, 1345, 1341, 1367, 1499, 1529, 2125, 1512, 1497, 1360, 772, 795, 772, 997, 975, 748, 1189,
    1291, 1205, 1291, 1220, 815, 1294, 1275, 555, 555, 1188, 555, 1869, 1275, 1256, 1291, 1291, 834,
    1147, 750, 1275, 1228, 1741, 1188, 1233, 1173, 960, 761, 960, 1390,
  ],
  800: [
    448, 734, 1201, 1342, 1352, 2108, 1399, 726, 783, 783, 1193, 1404, 722, 965, 722, 819, 1417,
    904, 1306, 1345, 1410, 1298, 1355, 1204, 1360, 1355, 722, 737, 1404, 1404, 1404, 1186, 2122,
    1576, 1361, 1523, 1480, 1249, 1199, 1541, 1533, 585, 1208, 1512, 1158, 1932, 1568, 1583, 1335,
    1601, 1356, 1352, 1386, 1489, 1576, 2168, 1559, 1540, 1390, 783, 819, 783, 1010, 992, 783, 1205,
    1306, 1219, 1306, 1230, 839, 1309, 1301, 580, 580, 1214, 580, 1899, 1301, 1268, 1306, 1306, 860,
    1174, 782, 1301, 1260, 1767, 1217, 1266, 1190, 996, 794, 996, 1404,
  ],
}

// Longer English prose sample for the average-char estimate — captions are
// overwhelmingly lowercase English in the target use cases.
const ENGLISH_SAMPLE =
  "The quick brown fox jumps over the lazy dog while the curious cat watches " +
  "from the windowsill and wonders whether dinner will arrive before midnight. " +
  "Every editor knows that timing is everything, so we measure twice and cut " +
  "once, keeping the pacing tight, the pauses intentional, and the words easy " +
  "to follow even when the scene is busy. Good captions stay out of the way " +
  "until the moment they are needed, then they speak clearly and step aside " +
  "again without fuss or ceremony. When the soundtrack swells and the frame " +
  "fills with motion, the text holds steady and readable, because a viewer who " +
  "can not hear the words should never miss the meaning. Simplicity is the " +
  "hardest feature to ship, and the most valuable one to keep."

function fallbackCharEm(code: number): number {
  // Ranges matched by script class: CJK ideographs + Kana + Hangul are
  // full-width; Cyrillic/Greek run slightly narrow; emoji run wide; everything
  // else falls back to a neutral mid-width.
  if (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0x1f000 && code <= 0x1faff)
  ) {
    return code >= 0x1f000 ? 1.15 : 1
  }
  if ((code >= 0x0370 && code <= 0x03ff) || (code >= 0x0400 && code <= 0x04ff)) return 0.62
  return 0.6
}

function charAdvanceEm(char: string, weight: CaptionFontWeight): number {
  const code = char.codePointAt(0) ?? 0x20
  if (code >= ASCII_FIRST && code <= ASCII_LAST) {
    return INTER_ADVANCES[weight][code - ASCII_FIRST] / UNITS_PER_EM
  }
  // Accented Latin measures like its base letter: NFD decomposition strips the
  // combining marks so "é" lands on the "e" advance.
  const normalized = char.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  const base = normalized.codePointAt(0) ?? code
  if (base >= ASCII_FIRST && base <= ASCII_LAST) {
    return INTER_ADVANCES[weight][base - ASCII_FIRST] / UNITS_PER_EM
  }
  return fallbackCharEm(code)
}

/**
 * Estimated advance of `text` in em units at the given Inter weight. Kerning
 * is intentionally ignored — the sum of advances tracks shaped widths to
 * within a couple percent on English prose, which is all line breaking needs.
 */
export function measureCaptionTextEm(text: string, weight: CaptionFontWeight): number {
  let em = 0
  for (const char of text) {
    em += charAdvanceEm(char, weight)
  }
  return em
}

/** Mean em advance across the bundled English prose sample at `weight`. */
export function avgCharEm(weight: CaptionFontWeight): number {
  let em = 0
  let count = 0
  for (const char of ENGLISH_SAMPLE) {
    em += charAdvanceEm(char, weight)
    count += 1
  }
  return em / count
}
