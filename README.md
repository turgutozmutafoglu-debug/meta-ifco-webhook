# Meta Lead Ads → IFCO Yaka Kartı Entegrasyonu

Bu sunucu, Meta (Facebook/Instagram) Lead Ads formlarından gelen ziyaretçi
bilgilerini otomatik olarak IFCO'nun yaka kartı sistemine kaydeder.

## Akış

```
Ziyaretçi Meta formunu doldurur
        │
        ▼
Meta → POST /webhook (sadece leadgen_id gönderir)
        │
        ▼
Sunucu → Graph API'den lead detayını çeker (META_ACCESS_TOKEN ile)
        │
        ▼
Sunucu → IFCO referans verileriyle eşleştirir (ülke/şehir/unvan/ürün grubu)
        │
        ▼
Sunucu → POST https://www.ifco.com.tr/api/meta-api/badge/store (IFCO_API_TOKEN ile)
```

## ÖNEMLİ: İki farklı token var

- **META_ACCESS_TOKEN**: Bana ilettiğiniz `EAALf41...` ile başlayan token. Bu bir
  **Meta/Facebook** erişim token'ı — lead verisini Graph API'den çekmek için
  kullanılır. IFCO ile hiçbir ilgisi yok.
- **IFCO_API_TOKEN**: IFCO'dan **ayrıca** talep etmeniz gereken bir token.
  `/badge/store` ve diğer tüm IFCO endpoint'lerine erişim için gerekli.

Bu token'ı benimle veya başka bir yerde paylaştıysanız, canlı bir kimlik
bilgisidir — riskli. Mümkünse rotasyonunu (yenilenmesini) yapın ve ileride
credential'ları sohbet/mesaj yerine `.env` dosyasında saklayın.

## Kurulum

```bash
npm install
cp .env.example .env
# .env dosyasını doldurun (META_ACCESS_TOKEN, IFCO_API_TOKEN, META_APP_SECRET, META_VERIFY_TOKEN)
npm start
```

Node.js 18+ gerekir (global `fetch` kullanılıyor).

## Meta tarafında yapılacaklar

1. **Meta App Dashboard** → uygulamanızda **Webhooks** ürününü ekleyin.
2. **Callback URL**: sunucunuzun herkese açık HTTPS adresi + `/webhook`
   (örn. `https://sizin-domaininiz.com/webhook`). Yerelde test için
   `ngrok` veya benzeri bir tünel kullanabilirsiniz.
3. **Verify Token**: `.env` dosyasındaki `META_VERIFY_TOKEN` ile aynı değeri girin.
4. **Subscription Fields**: `leadgen` alanını seçin.
5. Sayfanızı (Page) uygulamaya **subscribe** edin (`/{page-id}/subscribed_apps`
   endpoint'i ile `leadgen_ids` field'ı üzerinden, ya da Dashboard üzerinden).
6. Kullandığınız `META_ACCESS_TOKEN`'ın bu sayfa için geçerli, leadgen okuma
   izni (`leads_retrieval`) olan bir token olduğundan emin olun. Kısa ömürlü
   bir kullanıcı token'ı yerine **sayfa token'ı** veya **sistem kullanıcısı
   token'ı** (uzun ömürlü) kullanmanız production için önerilir.

## Meta form soruları hakkında önemli not

`server.js` içindeki `FIELD_MAP` objesi, Meta lead formunuzdaki soru key'lerini
(`full_name`, `email`, `phone_number`, `company_name`, `country`, `city`,
`job_title`, `product_interest`) IFCO alanlarına eşliyor. Formu Meta'da
oluştururken:

- Mümkünse **ülke / şehir / unvan / ürün grubu** sorularını serbest metin
  yerine **açılır liste (dropdown)** yapın ve seçenekleri IFCO'nun referans
  listeleriyle (`/countries`, `/cities`, `/titles`, `/product-groups`)
  birebir aynı yazın. Bu, eşleştirme hatalarını neredeyse sıfıra indirir.
- Serbest metin bırakırsanız, kod yaklaşık (fuzzy) eşleştirme yapar ama
  yazım farklılıklarında (`Istanbul` vs `İstanbul` gibi) eşleşme
  bulunamayabilir — bu durumlar loglanır, otomatik kayıt yapılmaz.

Form'unuzdaki gerçek soru key'lerini Graph API üzerinden
`GET /{form-id}` ile görüp `FIELD_MAP`'i buna göre güncelleyebilirsiniz.

## Zorunlu/opsiyonel alanlar (IFCO tarafı)

| Alan | Zorunlu | Not |
|---|---|---|
| name, email, ct_code_gsm, gsm, company, country, title | Evet | `title` bir ID, eşleşmezse kayıt atlanır ve loglanır |
| city, product_group | Hayır | Eşleşmezse boş geçilir |

## Deployment önerisi

Küçük/orta trafik için: Railway, Render, veya bir VPS üzerinde `pm2` ile
çalıştırmak yeterli. HTTPS zorunludur (Meta webhook'ları sadece HTTPS kabul
eder).

```bash
npm install -g pm2
pm2 start server.js --name meta-ifco-webhook
pm2 save
```

## Güvenlik notları

- `META_APP_SECRET` mutlaka doldurulmalı — bu olmadan `X-Hub-Signature-256`
  doğrulaması atlanır ve herkes sahte lead POST edebilir.
- Token'ları asla kod içine gömmeyin, `.env` kullanın ve `.env` dosyasını
  git'e eklemeyin (`.gitignore`'a ekleyin).
- IFCO_API_TOKEN'ı sadece bu sunucuda saklayın, front-end/istemci tarafına
  asla göndermeyin.
