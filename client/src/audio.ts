import type Phaser from 'phaser'
import { emitUi } from './uibus'

// SFX (итерация 13): короткие звуки из CC0-пака Kenney Interface Sounds
// (https://kenney.nl/assets/interface-sounds, лицензия CC0 1.0).
// Файлы в client/public/assets/sfx — отдаются Vite как статика.

const FILES = {
  click: 'click_001.ogg', // активный клик: мотивация, починка
  select: 'select_001.ogg', // покупка, кнопка
  confirmation: 'confirmation_001.ogg', // успех: премия, победа
  error: 'error_001.ogg', // отказ сервера
  glitch: 'glitch_001.ogg', // поломка/банкротство
  question: 'question_001.ogg', // появление события
  bong: 'bong_001.ogg', // конец дня
  drop: 'drop_002.ogg', // убыток/штраф
} as const

export type SfxName = keyof typeof FILES

export function preloadSfx(scene: Phaser.Scene) {
  for (const [name, file] of Object.entries(FILES)) {
    scene.load.audio(`sfx:${name}`, `assets/sfx/${file}`)
  }
}

// Звук — украшение, а не канал информации: любая ошибка воспроизведения
// глотается, играем без звука. Каждый вызов (любым исходом) пишется в шину
// UI-событий (ITGAME-38) — itd.log() видит воспроизведённые звуки: ключ
// ассета, громкость, сцену и успех воспроизведения.
export function playSfx(scene: Phaser.Scene, name: SfxName, volume = 0.35) {
  const key = `sfx:${name}`
  let ok = true
  try {
    ok = scene.sound.play(key, { volume }) !== false
  } catch {
    // нет кодека/автоплей-политики — молча
    ok = false
  }
  emitUi({ type: 'sound', key, name, volume, scene: scene.scene.key, ok })
}
