import Phaser from 'phaser'
import { client } from '../net'
import { MobileScene } from './MobileScene'

// Вход мобильного клиента (ITGAME-227, эпик ITGAME-225): /mobile.html, второй вход Vite.
// Сюда уводит гейт index.html (ITGAME-161). Сеть, сейв и sid — общие с десктопом (net.ts),
// вкладка только называет себя серверу client=mobile (ITGAME-162).
client.kind = 'mobile'

// Первый текст сцены должен рисоваться уже Departure Mono (как ждёт BootScene десктопа);
// не загрузился шрифт — рисуем запасным, а не висим.
await document.fonts.load(`16px 'Departure Mono'`).catch(() => [])

// RESIZE берёт размер у #app: на нуле (вкладка открыта скрытой) WebGL-рендерер Phaser падает на
// старте «Framebuffer status: Incomplete Attachment» — ждём, пока у #app появится площадь.
const app = document.getElementById('app')!
const hasArea = () => app.clientWidth > 0 && app.clientHeight > 0
if (!hasArea()) {
  await new Promise<void>((done) => {
    const ro = new ResizeObserver(() => {
      if (hasArea()) { ro.disconnect(); done() }
    })
    ro.observe(app)
  })
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  backgroundColor: '#1a1c2c',
  pixelArt: true,
  // Размер по окну, без фиксированных 1280×720 десктопа: канвас — ровно #app.
  scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
  scene: [MobileScene],
})

// Кэш «назад/вперёд» (ITGAME-19), как у десктопа: уходя в bfcache, страница отпускает сессию.
addEventListener('pagehide', (e) => {
  if (e.persisted) client.suspend()
})
addEventListener('pageshow', (e) => {
  if (e.persisted) client.resume()
})
