#!/usr/bin/env node
/**
 * Validates the bundled font library: catalog schema, unique ids, files present with the
 * declared size and a WOFF2 signature, the 300 KB per-file limit, the total budget, an allowed
 * licence with its text next to the files, and an entry per family in THIRD-PARTY.md.
 *
 *   node tools/fonts/validate-fonts.mjs        # exit 1 on any error
 *
 * `validateCatalog` is pure (I/O injected) so the tests run it on fixtures.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_LABELS } from './categories.mjs';

export const ALLOWED_LICENSES = ['OFL-1.1', 'Apache-2.0', 'UFL-1.0', 'CC0-1.0', 'MIT', 'mit', 'Unlicense'];
export const MAX_FILE_BYTES = 300 * 1024;
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const SUBSETS = ['latin', 'latin-ext'];
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * @param catalog parsed fonts.json
 * @param io { exists(rel), size(rel), head(rel) → first bytes as string, text(rel) } paths relative to public/fonts
 * @param thirdParty contents of THIRD-PARTY.md (or null to skip that check)
 * @returns list of error strings (empty = valid)
 */
export function validateCatalog(catalog, io, thirdParty = null) {
  const err = [];
  const e = (m) => err.push(m);
  if (!catalog || typeof catalog !== 'object') return ['catálogo vacío o no es un objeto'];
  if (catalog.version !== 1) e(`version debe ser 1 (es ${catalog.version})`);
  if (!Array.isArray(catalog.families) || !catalog.families.length) return [...err, 'families vacío'];
  const ids = new Set();
  const names = new Set();
  let total = 0;
  for (const [i, f] of catalog.families.entries()) {
    const at = `familia ${i} (${f?.id ?? '?'})`;
    if (!f || typeof f !== 'object') { e(`${at}: no es un objeto`); continue; }
    if (typeof f.id !== 'string' || !ID.test(f.id)) e(`${at}: id no válido`);
    else if (ids.has(f.id)) e(`${at}: id duplicado`);
    else ids.add(f.id);
    if (typeof f.family !== 'string' || !f.family.trim()) e(`${at}: falta family`);
    else if (names.has(f.family)) e(`${at}: familia duplicada «${f.family}»`);
    else names.add(f.family);
    if (!Array.isArray(f.categories) || !f.categories.length) e(`${at}: sin categorías`);
    else for (const c of f.categories) if (!(c in CATEGORY_LABELS)) e(`${at}: categoría desconocida «${c}»`);
    if (f.redistributable !== true) e(`${at}: no está marcada como redistribuible`);
    const lic = f.license;
    if (!lic || !ALLOWED_LICENSES.includes(lic.id)) e(`${at}: licencia no permitida «${lic?.id}»`);
    if (!lic?.file || !io.exists(lic.file)) e(`${at}: falta el texto de la licencia (${lic?.file})`);
    else if (io.size(lic.file) < 200 || !/licen[cs]e/i.test(io.text(lic.file))) e(`${at}: el archivo de licencia no parece una licencia`);
    if (!f.package?.name || !f.package?.version) e(`${at}: falta el paquete de origen`);
    if (!f.photopea || typeof f.photopea.matched !== 'boolean') e(`${at}: falta photopea.matched`);
    if (!(f.substituteFor === null || typeof f.substituteFor === 'string')) e(`${at}: substituteFor debe ser null o texto`);
    if (!Array.isArray(f.subsets) || !f.subsets.includes('latin')) e(`${at}: sin subconjunto latin`);
    if (!Array.isArray(f.variants) || !f.variants.length) { e(`${at}: sin variantes`); continue; }
    for (const v of f.variants) {
      const vat = `${at} ${v?.style} ${v?.weight}`;
      if (v.style !== 'normal' && v.style !== 'italic') e(`${vat}: estilo no válido`);
      const w = v.weight;
      const okW = (n) => Number.isInteger(n) && n >= 1 && n <= 1000;
      if (Array.isArray(w) ? !(w.length === 2 && okW(w[0]) && okW(w[1]) && w[0] <= w[1]) : !okW(w)) e(`${vat}: peso no válido`);
      if (Array.isArray(w) !== !!f.variable) e(`${vat}: el peso no concuerda con variable=${f.variable}`);
      if (v.format !== 'woff2') e(`${vat}: formato no permitido`);
      if (!Array.isArray(v.files) || !v.files.length) { e(`${vat}: sin archivos`); continue; }
      for (const x of v.files) {
        if (!SUBSETS.includes(x.subset)) e(`${vat}: subconjunto «${x.subset}» fuera del presupuesto`);
        if (typeof x.file !== 'string' || !x.file.startsWith(`files/${f.id}/`) || x.file.includes('..')) { e(`${vat}: ruta no válida «${x.file}»`); continue; }
        if (!io.exists(x.file)) { e(`${vat}: falta ${x.file}`); continue; }
        const size = io.size(x.file);
        if (size !== x.bytes) e(`${vat}: ${x.file} mide ${size} B y el catálogo dice ${x.bytes}`);
        if (size > MAX_FILE_BYTES) e(`${vat}: ${x.file} supera ${MAX_FILE_BYTES / 1024} KB`);
        if (io.head(x.file) !== 'wOF2') e(`${vat}: ${x.file} no es WOFF2`);
        total += size;
      }
    }
    if (thirdParty !== null && f.family && !thirdParty.includes(`| ${f.family} |`)) e(`${at}: falta en THIRD-PARTY.md`);
  }
  if (total > MAX_TOTAL_BYTES) e(`total ${(total / 1048576).toFixed(1)} MB supera el presupuesto de ${MAX_TOTAL_BYTES / 1048576} MB`);
  return err;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const base = join(root, 'public', 'fonts');
  const catalog = JSON.parse(readFileSync(join(base, 'catalog', 'fonts.json'), 'utf8'));
  const p = (rel) => join(base, rel);
  const io = {
    exists: (rel) => existsSync(p(rel)),
    size: (rel) => statSync(p(rel)).size,
    head: (rel) => readFileSync(p(rel)).subarray(0, 4).toString('latin1'),
    text: (rel) => readFileSync(p(rel), 'utf8'),
  };
  const errors = validateCatalog(catalog, io, readFileSync(join(root, 'THIRD-PARTY.md'), 'utf8'));
  const files = catalog.families.reduce((s, f) => s + f.variants.reduce((t, v) => t + v.files.length, 0), 0);
  const bytes = catalog.families.reduce((s, f) => s + f.variants.reduce((t, v) => t + v.files.reduce((u, x) => u + x.bytes, 0), 0), 0);
  if (errors.length) {
    console.error(`${errors.length} errores:\n  ${errors.slice(0, 40).join('\n  ')}`);
    process.exit(1);
  }
  console.log(`catálogo válido: ${catalog.families.length} familias · ${files} archivos · ${(bytes / 1048576).toFixed(1)} MB · licencias y THIRD-PARTY.md completos`);
}
