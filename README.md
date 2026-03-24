# YouTube Subtitle Notes Extension

Bu Chrome extension, YouTube video sayfasındaki altyazıları not olarak kaydeder.

## Özellikler

- Aktif YouTube videosunun altyazısını alır
- İngilizce altyazıyı Türkçeye çevirir
- Notları `chrome.storage.local` içine kaydeder
- Son notu veya listedeki bir notu `.txt` olarak indirir

## Kurulum

1. Chrome'da `chrome://extensions` sayfasını aç
2. `Developer mode` seçeneğini aktif et
3. `Load unpacked` butonuna tıkla
4. Bu klasörü seç: `/Users/anilyilmaz/Desktop/nest/ext`

## Kullanım

1. YouTube'da bir video aç
2. Extension popup'ını aç
3. `Aktif Videoyu Kaydet` butonuna tıkla
4. Kaydedilen notu popup üzerinden indir

## Not

- Video üzerinde altyazı mevcut olmalıdır
- Çeviri için `translate.googleapis.com` isteği kullanılır
- Bazı videolarda otomatik altyazı veya bölgesel kısıtlar nedeniyle sonuç alınamayabilir
