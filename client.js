/*!
 * dsh-recall — client half. Strip under the composer: how much was moved out,
 * how often the model went back for it, and what that saved.
 */
window.__ModuleLoader__.load({
  id: 'dsh-recall',
  factory: function (require) {
    const React = require('react')
    const module = { exports: {} }
    const h = React.createElement
    const { useState, useEffect, useCallback } = React
    const API = '/recall/api'

    const STR = {
      en: {
        strip: 'recall',
        none: 'nothing offloaded yet',
        off: '{n} results offloaded',
        saved: '{t} tok saved',
        back: '{n} recalls',
        hint: 'Big tool results keep their head inline; the rest goes to disk under an object id the model can recall.',
        recent: 'Recent',
        empty: 'No result has crossed the size threshold yet.',
        look: 'threshold {n} chars',
      },
      ru: {
        strip: 'память',
        none: 'пока ничего не вынесено',
        off: 'вынесено результатов: {n}',
        saved: 'сохранено {t} tok',
        back: 'обращений recall: {n}',
        hint: 'Крупные результаты держат начало в контексте, остальное лежит на диске под id — модель достаёт его через recall.',
        recent: 'Последние',
        empty: 'Ни один результат ещё не превысил порог.',
        look: 'порог {n} симв.',
      },
    }

    function useT() {
      let lang = 'en'
      try {
        if (typeof navigator !== 'undefined' && /^ru/i.test(navigator.language || '')) lang = 'ru'
      } catch {}
      const T = STR[lang] ?? STR.en
      return (key, vars) =>
        String(T[key] ?? STR.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (vars && k in vars ? vars[k] : `{${k}}`))
    }

    const nf = (n) => Number(n || 0).toLocaleString('ru-RU')

    function ago(ts) {
      const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
      if (s < 60) return `${s} с`
      const m = Math.round(s / 60)
      if (m < 60) return `${m} мин`
      const h = Math.round(m / 60)
      return h < 24 ? `${h} ч` : `${Math.round(h / 24)} дн`
    }

    const CSS = `
      .rc-strip{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted-foreground);
        padding:4px 8px;border-top:1px solid var(--border);cursor:pointer;user-select:none;flex-wrap:wrap}
      .rc-strip b{color:var(--foreground);font-weight:600}
      .rc-strip .rc-dot{width:6px;height:6px;border-radius:50%;background:var(--accent)}
      .rc-panel{font-size:12px;padding:8px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:6px}
      .rc-row{display:flex;justify-content:space-between;gap:10px;color:var(--muted-foreground)}
      .rc-row code{color:var(--foreground);font-size:11px}
    `

    function useStats() {
      const [data, setData] = useState(null)
      const load = useCallback(() => {
        fetch(`${API}/stats`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => d && setData(d))
          .catch(() => {})
      }, [])
      useEffect(() => {
        load()
        const id = setInterval(load, 12000)
        return () => clearInterval(id)
      }, [load])
      return data
    }

    function Strip() {
      const T = useT()
      const data = useStats()
      const [open, setOpen] = useState(false)
      if (!data) return null
      const recent = data.recent || []
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'rc-strip', onClick: () => setOpen(!open) },
          h('span', { className: 'rc-dot' }),
          h('b', null, T('strip')),
          h('span', null, data.offloaded ? T('off', { n: nf(data.offloaded) }) : T('none')),
          data.offloaded ? h('span', null, '·', h('b', null, ' ' + T('saved', { t: nf(data.tokensSaved) }))) : null,
          data.recalls ? h('span', null, '·', T('back', { n: nf(data.recalls) })) : null,
          h('span', { style: { marginLeft: 'auto' } }, open ? '▴' : '▾'),
        ),
        open
          ? h(
              'div',
              { className: 'rc-panel' },
              h('div', { className: 'rc-row' }, h('span', null, T('hint')), h('span', null, T('look', { n: nf(data.threshold) }))),
              recent.length === 0 ? h('div', { className: 'rc-row' }, T('empty')) : null,
              recent.map((e, i) =>
                h(
                  'div',
                  { className: 'rc-row', key: i },
                  h('code', null, `#${e.id} ${e.tool || ''}`),
                  h('span', null, `${nf(e.chars)} симв. · ${ago(e.ts)}`),
                ),
              ),
            )
          : null,
      )
    }

    function mount(ctx) {
      if (!document.getElementById('rc-css')) {
        const s = document.createElement('style')
        s.id = 'rc-css'
        s.textContent = CSS
        document.head.appendChild(s)
      }
      ctx.inject(['slots'], (scope) => {
        const slots = scope.slots
        if (!slots) return
        slots.inject('conversation.composer.dock', () =>
          slots
            .register({ name: 'conversation.composer.dock', id: 'recall-strip', order: 85, inject: () => ({}) }, Strip)
            .catch((e) => console.error('[recall] dock slot failed:', e && (e.message || e))),
        )
      })
    }

    function apply(ctx) {
      try {
        return mount(ctx)
      } catch (e) {
        console.error('[recall] mount failed:', e && (e.stack || e))
        throw e
      }
    }

    module.exports = { inject: ['slots', 'locale'], apply }
    return module.exports
  },
})
