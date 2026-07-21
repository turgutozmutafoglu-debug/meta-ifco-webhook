/**
 * Meta Lead Ads -> IFCO Yaka Kartı Entegrasyonu (POLLING SÜRÜMÜ)
 * ------------------------------------------------
 * Lead Access Manager izin sorunu nedeniyle webhook bildirimleri
 * sunucuya ulaşamadığından, bu sürüm periyodik olarak (polling)
 * sayfanın tüm formlarını Graph API üzerinden tarar ve yeni lead'leri
 * bulup IFCO'ya kaydeder.
 *
 * 1) Sayfadaki tüm formları listele (GET /{page-id}/leadgen_forms)
 * 2) Her formun /leads endpoint'ini periyodik olarak tara
 * 3) Daha önce işlenmemiş (yeni) lead'leri bul
 * 4) Çok dilli alan adı eşleştirmesiyle (email/telefon/isim/şirket/
 *    unvan/şehir/ülke/ürün grubu) ham veriyi ayıkla
 * 5) IFCO referans verileriyle eşleştir, /badge/store'a kaydet
 *
 * Not: Webhook endpoint'i de (aşağıda) korunuyor - ileride Lead Access
 * Manager izni düzelirse otomatik olarak devreye girer, zarar vermez.
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();

// Ham body'yi imza doğrulaması için saklıyoruz
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const {
  PORT = 3000,
  META_VERIFY_TOKEN, // Meta webhook kurulumunda belirlediğiniz doğrulama string'i
  META_APP_SECRET, // Meta App Dashboard > Settings > Basic > App Secret
  META_ACCESS_TOKEN, // Sağladığınız Page/System User access token
  META_PAGE_ID = "100664412375646", // IFCO - Istanbul Fashion Connection sayfa ID'si
  IFCO_API_BASE = "https://www.ifco.com.tr/api/meta-api",
  IFCO_API_TOKEN, // IFCO'dan ayrıca alınacak Bearer token
  GRAPH_API_VERSION = "v20.0",
  POLL_INTERVAL_MINUTES = "5",
} = process.env;

// ---------------------------------------------------------------------------
// ÇOK DİLLİ ALAN ADI EŞLEŞTİRME
// Formlar 9 farklı dilde (Almanca, Portekizce, İtalyanca, İspanyolca,
// Arapça, Fransızca, Rusça, İngilizce, Türkçe) olduğu için Meta'nın
// oluşturduğu alan (field) adları dile göre değişiyor
// (örn. "e-mail-adresse", "produktgruppen" gibi). Bu yüzden sabit
// key eşleştirmesi yerine, alan adının içinde geçen anahtar kelimelere
// bakarak otomatik sınıflandırma yapıyoruz.
// ---------------------------------------------------------------------------
function normalizeKey(s = "") {
  return s
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // aksanları temizle (ä->a, ş->s, ü->u vb.)
}

const FIELD_KEYWORDS = {
  email: ["mail"],
  gsm: ["telefon", "phone", "teléfono", "telefono", "téléphone", "telephone", "telefone", "телефон", "هاتف", "numero_de_tel"],
  company: ["firma", "firm", "empresa", "entreprise", "azienda", "sirket", "şirket", "company", "компани", "شركة", "unternehmen"],
  title: ["position", "posizione", "posicao", "poste", "cargo", "unvan", "должность", "منصب", "job_title", "jobtitle", "titel", "title", "وظيفي", "مسمى"],
  city: ["stadt", "ciudad", "ville", "cidade", "citta", "città", "sehir", "şehir", "город", "مدينة", "city"],
  country: ["land", "pais", "país", "pays", "paese", "ulke", "ülke", "страна", "بلد", "country"],
  product_group: ["produkt", "product", "groduct", "grupo", "groupe", "gruppo", "grup", "группа", "مجموعة", "منتج", "urun", "ürün"],
  name: ["vollstandig", "vollständig", "full_name", "fullname", "nombre_completo", "nom_complet", "nome_completo", "tam_ad", "ad_soyad", "soyad", "полное_имя", "الاسم_الكامل", "الاسم"],
};

function classifyField(rawKey, value) {
  const key = normalizeKey(rawKey);
  // Email: hem alan adına hem de değere (@ işareti) bakıyoruz
  if (FIELD_KEYWORDS.email.some((kw) => key.includes(kw))) return "email";
  if (typeof value === "string" && /@/.test(value) && /\./.test(value)) return "email";

  for (const [internalKey, keywords] of Object.entries(FIELD_KEYWORDS)) {
    if (internalKey === "email") continue;
    if (keywords.some((kw) => key.includes(kw))) return internalKey;
  }

  // Telefon numarası formatına benziyorsa (alan adından anlaşılamadıysa)
  if (typeof value === "string" && /^\+?[\d\s()-]{7,}$/.test(value.trim())) {
    return "gsm";
  }

  return null; // sınıflandırılamadı
}

// ---------------------------------------------------------------------------
// TELEFON KODU AYIRMA
// E.164 benzeri numaralardan (+49..., +90..., 0049... vb.) ülke kodunu
// ayıklıyoruz. Yaygın çağrı kodlarını uzundan kısaya doğru deniyoruz.
// ---------------------------------------------------------------------------
const CALLING_CODES = [
  "971", "966", "965", "974", "973", "968", "962", "961", "963", "964",
  "212", "213", "216", "351", "352", "353", "354", "355", "356", "357",
  "358", "420", "421",
  "43", "41", "31", "32", "49", "90", "33", "39", "34", "44", "20",
  "55", "52", "54", "46", "47", "48", "36", "40", "30",
  "7", "1",
].sort((a, b) => b.length - a.length);

function parsePhone(raw = "") {
  let digits = raw.replace(/[^\d]/g, "");
  // 00 ile başlıyorsa uluslararası çağrı öneki, kaldır
  if (digits.startsWith("00")) digits = digits.slice(2);
  for (const code of CALLING_CODES) {
    if (digits.startsWith(code)) {
      return { ct_code_gsm: code, gsm: digits.slice(code.length) };
    }
  }
  // Bilinmeyen kod: ilk 2 haneyi kod say, geri kalanı numara
  return { ct_code_gsm: digits.slice(0, 2), gsm: digits.slice(2) };
}

// ---------------------------------------------------------------------------
// ÜLKE ADI TAKMA ADLARI (ISO kod / yerel dil -> findBestMatch için ortak ad)
// ---------------------------------------------------------------------------
const COUNTRY_ALIASES = {
  DE: "Germany", Deutschland: "Germany", Germany: "Germany",
  TR: "Turkey", Türkiye: "Turkey", Turkiye: "Turkey", Turkey: "Turkey",
  FR: "France", France: "France",
  IT: "Italy", Italia: "Italy", Italy: "Italy",
  ES: "Spain", "España": "Spain", Espana: "Spain", Spain: "Spain",
  PT: "Portugal", Portugal: "Portugal",
  RU: "Russia", "Россия": "Russia", Russia: "Russia",
  GB: "United Kingdom", UK: "United Kingdom", "United Kingdom": "United Kingdom",
  US: "United States", USA: "United States", "United States": "United States",
  EG: "Egypt", Egypt: "Egypt",
  SA: "Saudi Arabia", "Saudi Arabia": "Saudi Arabia",
  AE: "United Arab Emirates", UAE: "United Arab Emirates",
  QA: "Qatar", KW: "Kuwait", BH: "Bahrain", OM: "Oman",
  JO: "Jordan", LB: "Lebanon", MA: "Morocco", DZ: "Algeria",
  TN: "Tunisia", IQ: "Iraq", SY: "Syria",
  AT: "Austria", CH: "Switzerland", NL: "Netherlands", BE: "Belgium",
  BR: "Brazil", MX: "Mexico", AR: "Argentina",
};

function resolveCountryAlias(raw = "") {
  const trimmed = raw.trim();
  return COUNTRY_ALIASES[trimmed] || COUNTRY_ALIASES[trimmed.toUpperCase()] || raw;
}

// ---------------------------------------------------------------------------
// Ülke eşleştirme: önce ISO kod (a2_iso alanı, dil bağımsız ve en güvenilir),
// bulunamazsa isim bazlı bulanık eşleştirme.
// ---------------------------------------------------------------------------
function matchCountry(rawValue) {
  if (!rawValue) return null;
  const val = rawValue.toString().trim();

  // 2 harfli ISO kod gibi görünüyorsa (Meta'nın ülke sorusu genelde bunu döner)
  if (/^[A-Za-z]{2}$/.test(val)) {
    const iso = val.toUpperCase();
    const found = cache.countries.find(
      (c) => (c.a2_iso || "").toUpperCase() === iso
    );
    if (found) return found;
  }

  // Yedek: takma ad çözümleyip isim bazlı bulanık eşleştir
  const resolved = resolveCountryAlias(val);
  return findBestMatch(resolved, cache.countries, "common_name");
}

// ---------------------------------------------------------------------------
// Referans veri önbelleği (countries / cities / titles / product-groups)
// Sık değişmeyen veriler olduğu için periyodik olarak yenileniyoruz.
// ---------------------------------------------------------------------------
const cache = {
  countries: [],
  titles: [],
  productGroups: [],
  citiesByCountry: new Map(), // countryId -> city[]
  lastRefresh: 0,
};

async function ifcoGet(path) {
  const res = await fetch(`${IFCO_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${IFCO_API_TOKEN}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`IFCO GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.data;
}

async function refreshReferenceData() {
  const [countries, titles, productGroups] = await Promise.all([
    ifcoGet("/countries"),
    ifcoGet("/titles"),
    ifcoGet("/product-groups"),
  ]);
  cache.countries = countries;
  cache.titles = titles;
  cache.productGroups = productGroups;
  cache.citiesByCountry.clear(); // şehirler lazy olarak çekilecek
  cache.lastRefresh = Date.now();
  console.log(
    `[cache] Yenilendi: ${countries.length} ülke, ${titles.length} unvan, ${productGroups.length} ürün grubu`
  );
  console.log("[cache] Unvan listesi: " + JSON.stringify(titles.map((t) => t.baslik)));
  console.log("[cache] Ürün grubu listesi: " + JSON.stringify(productGroups.map((p) => p.baslik)));
  console.log(
    "[cache] Türkiye ile ilgili ülke kayıtları: " +
      JSON.stringify(
        countries.filter(
          (c) => normalize(c.common_name).includes("turkiye") || normalize(c.common_name).includes("turkey")
        )
      )
  );
  console.log(
    "[cache] 'Yönetici' ile ilgili unvan kayıtları: " +
      JSON.stringify(
        titles.filter((t) =>
          extractLabelVariants(t.baslik).some((v) => normalize(v).includes("yonet"))
        )
      )
  );
}

async function getCitiesForCountry(countryId) {
  if (cache.citiesByCountry.has(countryId)) {
    return cache.citiesByCountry.get(countryId);
  }
  const cities = await ifcoGet(`/cities/${countryId}`);
  cache.citiesByCountry.set(countryId, cities);
  return cities;
}

// ---------------------------------------------------------------------------
// Basit normalize + eşleştirme yardımcıları
// Türkçe karakter farklarına ve büyük/küçük harfe toleranslı.
// ---------------------------------------------------------------------------
function normalize(str = "") {
  return str
    .toString()
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/İ/g, "i")
    .replace(/I/g, "ı")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // aksanları temizle (yaklaşık eşleştirme için)
}

function findBestMatch(input, list, labelField) {
  if (!input) return null;
  const target = normalize(input);
  // 1) tam eşleşme
  let match = list.find((item) => normalize(item[labelField]) === target);
  if (match) return match;
  // 2) içerir eşleşmesi (form cevabı fazladan kelime içerebilir)
  match = list.find(
    (item) =>
      normalize(item[labelField]).includes(target) ||
      target.includes(normalize(item[labelField]))
  );
  return match || null;
}

// ---------------------------------------------------------------------------
// IFCO'nun unvan/ürün grubu listesindeki "baslik" alanı düz metin DEĞİL,
// çok dilli bir obje: { tr, en, de, es, fr, it, ru, ar }. Form cevabı
// (hangi dilde olursa olsun) bu varyantlardan biriyle eşleşebilir, bu
// yüzden hepsini tarıyoruz. (Eğer baslik düz string ise de çalışır.)
// ---------------------------------------------------------------------------
function extractLabelVariants(baslik) {
  if (typeof baslik === "string") return [baslik];
  if (baslik && typeof baslik === "object") return Object.values(baslik);
  return [];
}

function findBestMultilangMatch(input, list) {
  if (!input) return null;
  const target = normalize(input);
  // 1) herhangi bir dil varyantında tam eşleşme
  let match = list.find((item) =>
    extractLabelVariants(item.baslik).some((v) => normalize(v) === target)
  );
  if (match) return match;
  // 2) herhangi bir dil varyantında içerir eşleşmesi
  match = list.find((item) =>
    extractLabelVariants(item.baslik).some(
      (v) => normalize(v).includes(target) || target.includes(normalize(v))
    )
  );
  return match || null;
}

// ---------------------------------------------------------------------------
// Meta Graph API'den lead detayını çek (tek lead - webhook yolunda kullanılır)
// ---------------------------------------------------------------------------
async function fetchLeadFromMeta(leadgenId) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${leadgenId}?access_token=${META_ACCESS_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Graph API hata: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return fieldDataToRaw(data.field_data);
}

function fieldDataToRaw(fieldData) {
  // field_data: [{ name: "e-mail-adresse", values: ["x@y.com"] }, ...]
  const raw = {};
  for (const f of fieldData || []) {
    raw[f.name] = f.values?.[0] ?? null;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Ham form verisini (dile bakılmaksızın) IFCO badge/store formatına dönüştür
// ---------------------------------------------------------------------------
async function buildBadgePayload(rawFields) {
  const mapped = {};
  const unclassified = [];
  for (const [rawKey, value] of Object.entries(rawFields)) {
    const internalKey = classifyField(rawKey, value);
    if (internalKey) {
      mapped[internalKey] = value;
    } else {
      unclassified.push(rawKey);
    }
  }
  if (unclassified.length) {
    console.warn(`[lead] Sınıflandırılamayan alanlar: ${unclassified.join(", ")}`);
  }

  // Telefon: ülke koduna göre ayır
  const { ct_code_gsm, gsm } = parsePhone(mapped.gsm || "");

  // Ülke eşleştirme: önce 2 harfli ISO koduyla (Meta genelde bunu döndürür,
  // IFCO listesinde de a2_iso alanı var - dil bağımsız en güvenilir yöntem).
  // Bulunamazsa isim bazlı bulanık eşleştirmeye düşer.
  const countryMatch = matchCountry(mapped.country);
  const countryName = countryMatch ? countryMatch.common_name : mapped.country;

  // Şehir eşleştirme (ülke bulunduysa)
  let cityName = mapped.city;
  if (countryMatch && mapped.city) {
    const cities = await getCitiesForCountry(countryMatch.id);
    const cityMatch = findBestMatch(mapped.city, cities, "name");
    if (cityMatch) cityName = cityMatch.name;
  }

  // Unvan eşleştirme (zorunlu alan - bulunamazsa varsayılan ilk unvana düşmeyin,
  // loglayıp elle incelemeniz daha güvenli)
  const titleMatch = findBestMultilangMatch(mapped.title, cache.titles);

  // Ürün grubu eşleştirme (virgülle ayrılmış olabilir)
  let productGroupIds = [];
  if (mapped.product_group) {
    const parts = mapped.product_group.split(",").map((s) => s.trim());
    for (const part of parts) {
      const pgMatch = findBestMultilangMatch(part, cache.productGroups);
      if (pgMatch) productGroupIds.push(pgMatch.id);
    }
  }

  const payload = {
    name: mapped.name,
    email: mapped.email,
    ct_code_gsm,
    gsm,
    company: mapped.company,
    country: countryName,
    title: titleMatch ? titleMatch.id : undefined,
    city: cityName,
    product_group: productGroupIds.length ? productGroupIds : undefined,
  };

  return { payload, unmatched: { title: !titleMatch && !!mapped.title, country: !countryMatch } };
}

async function submitBadge(payload) {
  const res = await fetch(`${IFCO_API_BASE}/badge/store`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IFCO_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error("[IFCO] Kayıt hatası:", res.status, json);
  } else {
    console.log("[IFCO] Kayıt sonucu:", json.message);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Webhook doğrulama (Meta App Dashboard > Webhooks kurulumunda çağrılır)
// ---------------------------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("[webhook] Doğrulama başarılı");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// İmza doğrulama - Meta'nın X-Hub-Signature-256 header'ını kontrol eder
// Bu olmadan herkes sahte lead POST edebilir.
// ---------------------------------------------------------------------------
function verifySignature(req) {
  if (!META_APP_SECRET) return true; // dev ortamında atlanabilir, prod'da ZORUNLU
  const signature = req.header("x-hub-signature-256");
  if (!signature) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ---------------------------------------------------------------------------
// Lead bildirimi alma
// ---------------------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  if (!verifySignature(req)) {
    console.warn("[webhook] Geçersiz imza - istek reddedildi");
    return res.sendStatus(401);
  }

  // Meta'ya hemen 200 dön, işlemi arka planda yap (Meta timeout'a duyarlıdır)
  res.sendStatus(200);

  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field !== "leadgen") continue;
        const leadgenId = change.value.leadgen_id;
        console.log(`[webhook] Yeni lead bildirimi: ${leadgenId}`);
        await processLead(leadgenId);
      }
    }
  } catch (err) {
    console.error("[webhook] İşleme hatası:", err);
  }
});

async function processLead(leadgenId, rawFieldsOverride) {
  // Referans veri 1 saatten eskiyse yenile
  if (Date.now() - cache.lastRefresh > 60 * 60 * 1000) {
    await refreshReferenceData();
  }

  const rawFields = rawFieldsOverride || (await fetchLeadFromMeta(leadgenId));
  console.log(`[lead ${leadgenId}] Ham form verisi:`, rawFields);

  const { payload, unmatched } = await buildBadgePayload(rawFields);

  if (!payload.email || !payload.title) {
    console.error(
      `[lead ${leadgenId}] Zorunlu alan eksik/eşleşmedi (email veya unvan). Manuel kontrol gerekiyor.`,
      { payload, unmatched }
    );
    return false;
  }

  await submitBadge(payload);
  return true;
}

// =============================================================================
// POLLING MEKANİZMASI
// Lead Access Manager izin sorunu nedeniyle webhook bildirimleri çalışmıyor.
// Bunun yerine periyodik olarak sayfanın tüm formlarını tarayıp yeni
// lead'leri kendimiz buluyoruz.
// =============================================================================

const STATE_FILE = path.join(__dirname, "poll-state.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { forms: {} }; // forms: { [formId]: lastCreatedTimeUnix }
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[poll] Durum dosyası kaydedilemedi:", err.message);
  }
}

let pollState = loadState();

async function graphGet(pathAndQuery) {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${pathAndQuery}${sep}access_token=${META_ACCESS_TOKEN}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Graph API hata (${pathAndQuery}): ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function listAllForms() {
  const forms = [];
  let next = `${META_PAGE_ID}/leadgen_forms?fields=id,name,status&limit=100`;
  while (next) {
    const json = await graphGet(next);
    forms.push(...(json.data || []));
    if (json.paging && json.paging.next) {
      // paging.next zaten tam URL + token içeriyor, doğrudan fetch edelim
      const res = await fetch(json.paging.next);
      const nextJson = await res.json();
      forms.push(...(nextJson.data || []));
      next = null; // basitlik için 2 sayfa sonrası duruyoruz (form sayısı azdır)
    } else {
      next = null;
    }
  }
  return forms.filter((f) => f.status === "ACTIVE");
}

async function pollForm(form) {
  const json = await graphGet(
    `${form.id}/leads?fields=created_time,field_data&limit=50`
  );
  const leads = json.data || [];
  if (!leads.length) return;

  const lastSeen = pollState.forms[form.id] || 0;
  // Graph API en yeniden en eskiye doğru döner; kronolojik işlemek için ters çevir
  const newLeads = leads
    .filter((l) => new Date(l.created_time).getTime() / 1000 > lastSeen)
    .reverse();

  if (!newLeads.length) return;

  console.log(`[poll] ${form.name}: ${newLeads.length} yeni lead bulundu`);

  let maxCreated = lastSeen;
  for (const lead of newLeads) {
    const createdUnix = new Date(lead.created_time).getTime() / 1000;
    try {
      const raw = fieldDataToRaw(lead.field_data);
      await processLead(lead.id, raw);
    } catch (err) {
      console.error(`[poll] Lead ${lead.id} işlenirken hata:`, err.message);
    }
    if (createdUnix > maxCreated) maxCreated = createdUnix;
  }

  pollState.forms[form.id] = maxCreated;
  saveState(pollState);
}

async function pollAllForms() {
  try {
    if (Date.now() - cache.lastRefresh > 60 * 60 * 1000) {
      await refreshReferenceData();
    }
    const forms = await listAllForms();
    console.log(`[poll] ${forms.length} aktif form taranıyor...`);
    for (const form of forms) {
      // İlk kez görülen form: geçmişi işlemeye çalışmadan, şu andan itibaren takip et
      if (pollState.forms[form.id] === undefined) {
        pollState.forms[form.id] = Math.floor(Date.now() / 1000);
        console.log(`[poll] Yeni form kaydedildi (geçmiş atlanıyor): ${form.name}`);
        continue;
      }
      await pollForm(form);
    }
    saveState(pollState);
  } catch (err) {
    console.error("[poll] Genel tarama hatası:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Manuel test endpoint'i: belirli bir lead ID'sini elle yeniden işler.
// Poll döngüsünü beklemeden, düzeltmelerin gerçekten çalışıp çalışmadığını
// (ve IFCO'ya kayıt gidip gitmediğini) anında test etmek için kullanılır.
// Örnek: /admin/reprocess?secret=<META_VERIFY_TOKEN>&lead_id=851259777818019
// ---------------------------------------------------------------------------
app.get("/admin/reprocess", async (req, res) => {
  if (req.query.secret !== META_VERIFY_TOKEN) {
    return res.sendStatus(403);
  }
  const leadId = req.query.lead_id;
  if (!leadId) {
    return res.status(400).json({ error: "lead_id parametresi gerekli" });
  }
  try {
    const ok = await processLead(leadId);
    res.json({ processed: ok, lead_id: leadId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`Webhook/Polling sunucusu ${PORT} portunda çalışıyor`);
  try {
    await refreshReferenceData();
  } catch (err) {
    console.error("Başlangıç referans verisi çekilemedi:", err.message);
  }

  const intervalMs = Number(POLL_INTERVAL_MINUTES) * 60 * 1000;
  console.log(`[poll] Periyodik tarama her ${POLL_INTERVAL_MINUTES} dakikada bir çalışacak`);
  await pollAllForms(); // başlangıçta bir kez çalıştır
  setInterval(pollAllForms, intervalMs);
});
