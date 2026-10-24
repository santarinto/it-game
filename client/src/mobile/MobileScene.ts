import Phaser from 'phaser'
import { client, hasSavedSession, prepareNewGame, savedDifficulty } from '../net'
import { resetForNewGame } from '../party'
import { fmtMoney } from '../format'
import { mobileSummary } from './summary'
import type { StateMessage } from '../protocol'

// Каркас мобильного клиента (ITGAME-227): одна сцена на весь экран телефона, размер — по окну
// (Scale.RESIZE), раскладка колонкой под портрет, пока ориентацию не решил ITGAME-226. Партия —
// тот же GameClient, что у десктопа (net.ts), с client=mobile. На экране минимум, по которому
// видно, что снапшот приходит: деньги, день и время, офисы; кнопка — только чтобы войти в
// партию и не застрять на закрытом дне. Ввода касанием по игре здесь ещё нет.

const FONT = "'Departure Mono', 'ITD Symbols', monospace"
const C = { bg: 0x1a1c2c, text: '#f4f4f4', dim: '#94b0c2', accent: '#ffcd75', btn: 0x3b5dc9, btnDown: 0x41a6f6 }

type Action = { label: string; run: () => void } | null

export class MobileScene extends Phaser.Scene {
  private title!: Phaser.GameObjects.Text
  private money!: Phaser.GameObjects.Text
  private day!: Phaser.GameObjects.Text
  private phase!: Phaser.GameObjects.Text
  private offices!: Phaser.GameObjects.Text
  private status!: Phaser.GameObjects.Text
  private btnBg!: Phaser.GameObjects.Rectangle
  private btnText!: Phaser.GameObjects.Text
  private action: Action = null
  private connected = false // connect() уже звали: новая партия сперва закрывает сокет

  constructor() {
    super('mobile')
  }

  create() {
    const res = Math.min(window.devicePixelRatio || 1, 3) // текст в разрешении экрана, не CSS px
    const text = (color: string) => this.add.text(0, 0, '', { fontFamily: FONT, color, resolution: res })
    this.title = text(C.accent).setText('IT Director')
    this.money = text(C.text)
    this.day = text(C.text)
    this.phase = text(C.dim)
    this.offices = text(C.text)
    this.status = text(C.dim)
    this.btnBg = this.add.rectangle(0, 0, 10, 10, C.btn).setOrigin(0, 0).setInteractive({ useHandCursor: true })
    this.btnText = text(C.text).setOrigin(0.5, 0.5)
    this.btnBg.on('pointerdown', () => this.btnBg.setFillStyle(C.btnDown))
    this.btnBg.on('pointerout', () => this.btnBg.setFillStyle(C.btn))
    this.btnBg.on('pointerup', () => {
      this.btnBg.setFillStyle(C.btn)
      this.action?.run()
    })

    const unsub = client.subscribe({
      onState: (s) => this.showState(s),
      onError: (code) => this.setStatus(`отказ сервера: ${code}`),
      onDisconnect: (reason) => this.setStatus(reason === 'session_taken'
        ? 'партию открыли в другой вкладке'
        : 'нет связи с сервером'),
      onReconnecting: (attempt) => this.setStatus(`переподключение… (${attempt})`),
      onGameOver: () => this.setAction({ label: 'Новая игра', run: () => this.newGame() }),
      onVictory: () => this.setAction({ label: 'Новая игра', run: () => this.newGame() }),
    })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsub)
    this.scale.on(Phaser.Scale.Events.RESIZE, () => this.layout())

    this.setStatus('не подключено')
    this.setAction(hasSavedSession()
      ? { label: 'Продолжить', run: () => this.join(false) }
      : { label: 'Новая игра', run: () => this.join(true) })
  }

  private join(fresh: boolean) {
    if (fresh) {
      prepareNewGame()
      resetForNewGame()
    }
    client.connect(fresh ? 'normal' : savedDifficulty())
    this.connected = true
    this.setStatus('подключение…')
    this.setAction(null)
  }

  // После финала сессия на сервере жива до выхода (ITGAME-51): старый сокет закрываем сами.
  private newGame() {
    if (this.connected) client.disconnect()
    this.join(true)
  }

  private showState(s: StateMessage) {
    const v = mobileSummary(s, fmtMoney)
    this.money.setText(v.money)
    this.day.setText(v.day)
    this.phase.setText(v.phase)
    this.offices.setText(v.offices.join('\n'))
    this.setStatus(`связь есть · снапшот ${s.rev}`)
    if (s.phase === 'day_report') this.setAction({ label: 'Следующий день', run: () => client.send('next_day') })
    else if (s.phase === 'running') this.setAction(null)
    this.layout()
  }

  private setStatus(t: string) {
    this.status.setText(t)
    this.layout()
  }

  private setAction(a: Action) {
    this.action = a
    this.btnText.setText(a?.label ?? '')
    this.btnBg.setVisible(a !== null)
    this.btnText.setVisible(a !== null)
    this.layout()
  }

  // Колонка с полями 16 px; кегль от ширины экрана, кнопка во всю ширину, высотой под палец.
  private layout() {
    const { width } = this.scale.gameSize
    const pad = 16
    const base = Phaser.Math.Clamp(Math.round(width / 22), 14, 22)
    let y = pad + 8
    const place = (t: Phaser.GameObjects.Text, size: number, gap: number) => {
      t.setFontSize(size).setWordWrapWidth(width - pad * 2).setPosition(pad, y)
      if (t.text !== '') y += t.height + gap
    }
    place(this.title, Math.round(base * 1.3), 20)
    place(this.money, Math.round(base * 1.6), 8)
    place(this.day, base, 4)
    place(this.phase, base, 16)
    place(this.offices, base, 16)
    place(this.status, Math.round(base * 0.85), 20)
    const h = Math.max(48, Math.round(base * 2.6))
    this.btnBg.setPosition(pad, y).setSize(width - pad * 2, h)
    this.btnBg.input?.hitArea.setTo(0, 0, width - pad * 2, h)
    this.btnText.setFontSize(base).setPosition(width / 2, y + h / 2)
  }
}
