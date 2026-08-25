import type Phaser from 'phaser'

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
// глотается, играем без звука.
export function playSfx(scene: Phaser.Scene, name: SfxName, volume = 0.35) {
  try {
    scene.sound.play(`sfx:${name}`, { volume })
  } catch {
    // нет кодека/автоплей-политики — молча
  }
}
