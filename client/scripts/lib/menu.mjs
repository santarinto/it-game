// menu — готовность меню для QA-скриптов (ITGAME-133).
//
// Готово — это itd.state().menuReady (контракт itd.state, ITGAME-19/88), а не
// «плашка menu.diff.normal уже в ids()». Плашки MenuScene.create() рисует
// сразу, а при сохранённом sid (localStorage или sessionStorage —
// hasSavedSession() в net.ts) меню ещё ждёт сводку сейва (/ws?peek=1). Пока она
// в пути, saveView() 'loading' → needsConfirm(), и клик или клавиша сложности
// открывают «Начать заново?» вместо старта партии (ITGAME-130). menuReady
// заодно ждёт, пока перезапуск меню (itd.sandbox()/restore()) уйдёт из
// очереди: после true плашки не сдвигаются, cx/cy годятся для мыши.
//
// Раньше каждый скрипт носил свою копию ожидания: у шести предикат был по
// плашке, у двух — по isActive('menu'). В большинстве гонку прятал свежий
// профиль браузера: без sid сводку ждать незачем, и menuReady наступает вместе
// с плашкой. Скрипт, который ставит sid до документа (qa:trace, qa:contract,
// qa:facade) или открывает вторую вкладку в том же браузере, на слабом
// предикате кликал в 'loading'.
//
// Проверка плашки осталась от копий qa:trace/qa:contract. При menuReady блок
// сложности уже нарисован, так что она ничего не стоит, но держит вызывающих,
// которые дальше кликают именно по нему.
export async function waitMenuReady(page, { timeout = 20000 } = {}) {
  await page.waitForFunction(
    () =>
      window.itd != null &&
      window.itd.state().menuReady === true &&
      window.itd.ids().some((n) => n.id === 'menu.diff.normal'),
    { timeout },
  )
}
