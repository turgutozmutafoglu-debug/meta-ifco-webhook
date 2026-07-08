# Meta Lead Ads → IFCO Yaka Kartı Entegrasyonu (Polling Sürümü)

Bu sunucu, Meta (Facebook/Instagram) Lead Ads formlarından gelen ziyaretçi
bilgilerini otomatik olarak IFCO'nun yaka kartı sistemine kaydeder.

## Neden Webhook Değil, Polling?

Normalde Meta, yeni bir lead geldiğinde sunucuya anlık bir bildirim
(webhook) gönderir. Ancak bu proje için sayfanın bağlı olduğu Business
Manager hesabında **Lead Access Manager** izin katmanı, App'in CRM
olarak tanınmasına izin vermedi (sayfa ve App farklı işletme
portföylerine ait olduğu için). Bu nedenle sunucu, webhook beklemek
yerine **periyodik olarak** (varsayılan: her 5 dakikada bir) sayfanın
tüm aktif formlarını tarayıp yeni lead'leri kendisi buluyor.

Webhook endpoint'i (`/webhook`) kodda hâlâ duruyor — ileride Lead
Access Manager izni düzeltilirse, Meta otomatik olarak bildirim
göndermeye başlar ve sistem karma çalışır (zararı olmaz).

## Akış

```
Her 5 dakikada bir:
        │
        ▼
Sunucu → Sayfanın tüm aktif formlarını listeler (GET /{page-id}/leadgen_forms)
        │
        ▼
Sunucu → Her formun son lead'lerini çeker (GET /{form-id}/leads)
        │
        ▼
Sunucu → Daha önce işlenmemiş (yeni) lead'leri tespit eder
        │
        ▼
Sunucu → Çok dilli alan adı sınıflandırması yapar
         (email/telefon/isim/şirket/unvan/şehir/ülke/ürün grubu)
        │
        ▼
Sunucu → IFCO referans verileriyle eşleştirir
        │
        ▼
Sunucu → POST https://www.ifco.com.tr/api/meta-api/badge/store
```

## Çok Dilli Form Desteği

Formlarınız 9 farklı dilde (Almanca, Portekizce, İtalyanca, İspanyolca,
Arapça, Fransızca, Rusça, İngilizce, Türkçe) olduğu için Meta'nın
oluşturduğu alan adları da dile göre değişiyor (örn. Almanca formda
"e-mail-adresse", "produktgruppen" gibi). Kod, sabit alan adı yerine
her alanın içinde geçen **anahtar kelimelere** bakarak otomatik
sınıflandırma yapıyor (`FIELD_KEYWORDS` listesi, `server.js` içinde).

Eğer bir dildeki form doğru sınıflandırılmıyorsa (loglarda
`Sınıflandırılamayan alanlar: ...` uyarısı görürsünüz), o dile ait
anahtar kelimeyi `FIELD_KEYWORDS` listesine eklemeniz yeterli.

## Önemli: Geçmiş Lead'ler İşlenmez

Sunucu ilk kez bir formu gördüğünde, o formun **geçmiş lead'lerini
otomatik olarak IFCO'ya aktarmaz** — sadece o andan itibaren gelen
yeni lead'leri işler. Bu, sistemin ilk çalıştırıldığında binlerce eski
lead'i birden IFCO'ya göndermesini önlemek için bilinçli bir tasarım
kararıdır. Geçmiş lead'leri manuel aktarmak isterseniz ayrı bir script
yazılabilir.

## Kurulum

```bash
npm install
cp .env.example .env
# .env dosyasını doldurun (META_ACCESS_TOKEN, META_PAGE_ID, IFCO_API_TOKEN vb.)
npm start
```

Node.js 18+ gerekir (global `fetch` kullanılıyor).

## ÖNEMLİ: İki farklı token var

- **META_ACCESS_TOKEN**: Bir **Meta/Facebook Page Access Token** —
  Graph API'den lead verisini çekmek ve form listesini almak için
  kullanılır.
- **IFCO_API_TOKEN**: IFCO'dan ayrıca alınmış bir token —
  `/badge/store` ve diğer IFCO endpoint'lerine erişim için gerekli.

`META_ACCESS_TOKEN` için **uzun ömürlü bir Page Access Token**
kullanmanız önerilir (kısa ömürlü user token'lar birkaç saatte
dolabilir, bu da polling'in sessizce durmasına yol açar). Token
süresi dolduğunda Railway loglarında `Graph API hata` mesajları
görürsünüz — bu durumda Graph API Explorer'dan yeni bir Page Access
Token üretip Railway'deki değişkeni güncellemeniz gerekir.

## Deployment (Railway)

1. Kodu GitHub'a push edin.
2. Railway → New Project → Deploy from GitHub repo.
3. Variables sekmesine `.env.example`'daki değişkenleri gerçek
   değerleriyle girin.
4. Settings → Networking → Generate Domain (opsiyonel, polling için
   dışarıdan erişilebilir bir adrese ihtiyaç yok, ama webhook
   endpoint'i için hazır bulunsun).

## İzleme

Railway → Deploy Logs'ta şu satırları görürsünüz:
```
[poll] N aktif form taranıyor...
[poll] <form adı>: N yeni lead bulundu
[lead <id>] Ham form verisi: {...}
[IFCO] Kayıt sonucu: ...
```

Bir lead'in zorunlu alanları (email/unvan) eşleşmediyse:
```
[lead <id>] Zorunlu alan eksik/eşleşmedi (email veya unvan). Manuel kontrol gerekiyor.
```
Bu durumda o lead IFCO'ya kaydedilmez, log'da ham veri ve eşleşmeyen
alanlar görünür — formdaki soru/cevap seçeneklerini IFCO'nun referans
listeleriyle uyumlu hale getirmeniz gerekebilir.

## Güvenlik notları

- Token'ları asla kod içine gömmeyin, sadece Railway Variables'ta
  saklayın.
- `poll-state.json` dosyası, hangi lead'lerin işlendiğini takip eder;
  silinirse (veya container yeniden oluşturulursa) tüm formlar "yeni"
  sayılıp o andan itibaren tekrar takip edilmeye başlanır (geçmiş
  lead'ler yine atlanır).
