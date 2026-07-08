/**
 * Meta Lead Ads -> IFCO Yaka Kartı Entegrasyonu
 * ------------------------------------------------
 * 1) Meta webhook doğrulama (GET /webhook)
 * 2) Meta webhook bildirimi alma (POST /webhook)
 * 3) Graph API'den lead detayını çekme
 * 4) IFCO referans verileriyle eşleştirme (ülke, şehir, unvan, ürün grubu)
 * 5) IFCO /badge/store endpoint'ine kayıt
 */

const express = require("express");
const crypto = require("crypto");
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
  IFCO_API_BASE = "https://www.ifco.com.tr/api/meta-api",
  IFCO_API_TOKEN, // IFCO'dan ayrıca alınacak Bearer token
  GRAPH_API_VERSION = "v20.0",
} = process.env;

// ---------------------------------------------------------------------------
// FORM ALAN EŞLEŞTİRME AYARI
// Meta lead formunuzdaki soru (question) key'lerini buraya göre düzenleyin.
// Formu Meta'da oluştururken "field key" olarak bu isimleri kullanmanız
// eşleştirmeyi çok daha güvenilir hale getirir.
// ---------------------------------------------------------------------------
const FIELD_MAP = {
  full_name: "name",
  email: "email",
  phone_number: "gsm", // Meta genelde +90XXXXXXXXXX formatında E.164 döner
  company_name: "company",
  country: "country", // form cevabı ülke adı olmalı
  city: "city", // form cevabı şehir adı olmalı
  job_title: "title", // form cevabı unvan adı olmalı (ID'ye çevrilecek)
  product_interest: "product_group", // form cevabı virgülle ayrılmış ürün grubu adları olabilir
};

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
// Meta Graph API'den lead detayını çek
// ---------------------------------------------------------------------------
async function fetchLeadFromMeta(leadgenId) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${leadgenId}?access_token=${META_ACCESS_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Graph API hata: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  // field_data: [{ name: "email", values: ["x@y.com"] }, ...]
  const raw = {};
  for (const f of data.field_data || []) {
    raw[f.name] = f.values?.[0] ?? null;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Ham form verisini IFCO badge/store formatına dönüştür
// ---------------------------------------------------------------------------
async function buildBadgePayload(rawFields) {
  const mapped = {};
  for (const [metaKey, internalKey] of Object.entries(FIELD_MAP)) {
    if (rawFields[metaKey] !== undefined) mapped[internalKey] = rawFields[metaKey];
  }

  // Telefon: E.164 formatından (+905427227652) alan kodu + numarayı ayır
  let ct_code_gsm = "90";
  let gsm = mapped.gsm || "";
  if (gsm.startsWith("+")) {
    // basit varsayım: Türkiye numaraları için +90 sonrası 10 hane
    const digits = gsm.replace(/\D/g, "");
    if (digits.startsWith("90")) {
      ct_code_gsm = "90";
      gsm = digits.slice(2);
    } else {
      gsm = digits;
    }
  }

  // Ülke eşleştirme
  const countryMatch = findBestMatch(mapped.country, cache.countries, "common_name");
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
  const titleMatch = findBestMatch(mapped.title, cache.titles, "baslik");

  // Ürün grubu eşleştirme (virgülle ayrılmış olabilir)
  let productGroupIds = [];
  if (mapped.product_group) {
    const parts = mapped.product_group.split(",").map((s) => s.trim());
    for (const part of parts) {
      const pgMatch = findBestMatch(part, cache.productGroups, "baslik");
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

async function processLead(leadgenId) {
  // Referans veri 1 saatten eskiyse yenile
  if (Date.now() - cache.lastRefresh > 60 * 60 * 1000) {
    await refreshReferenceData();
  }

  const rawFields = await fetchLeadFromMeta(leadgenId);
  console.log("[lead] Ham form verisi:", rawFields);

  const { payload, unmatched } = await buildBadgePayload(rawFields);

  if (!payload.email || !payload.title) {
    console.error(
      `[lead] Zorunlu alan eksik/eşleşmedi (email veya title). Manuel kontrol gerekiyor. Lead: ${leadgenId}`,
      { payload, unmatched }
    );
    // İsterseniz burada bir Slack/e-posta bildirimi tetikleyebilirsiniz.
    return;
  }

  await submitBadge(payload);
}

app.listen(PORT, async () => {
  console.log(`Webhook sunucusu ${PORT} portunda çalışıyor`);
  try {
    await refreshReferenceData();
  } catch (err) {
    console.error("Başlangıç referans verisi çekilemedi:", err.message);
  }
});
