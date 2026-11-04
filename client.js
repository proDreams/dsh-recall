/*!
 * dsh-recall — client half.
 *
 * A compact pill that sits in the same floating cluster as the dsh-tidewatch
 * badge: how much was moved out of the context, what that saved, and how often
 * the model came back for more. Click opens a blurred panel with the last
 * offloads. Everything is read from GET /recall/api/stats.
 *
 * The pill anchors itself to the tide chip's real rect when that plugin is
 * installed (so the two read as one card), and falls back to the bottom-right
 * corner when it is not. No coupling: tidewatch never knows we exist.
 */
window.__ModuleLoader__.load({
  id: 'dsh-recall',
  factory: function (require) {
    const React = require('react')
    const module = { exports: {} }
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React
    const API = '/recall/api'

    const STR = {
      en: {
        strip: 'recall',
        none: 'nothing offloaded yet',
        hint: 'Big tool results keep their head inline; the rest goes to disk under an object id the model can recall.',
        recent: 'Recent',
        empty: 'No result has crossed the size threshold yet.',
        look: 'threshold {n} chars',
      },
      ru: {
        strip: 'память',
        none: 'пока ничего не вынесено',
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
    const kk = (n) => {
      const v = Number(n || 0)
      if (v >= 1e6) return (v / 1e6).toFixed(1).replace('.', ',') + 'M'
      if (v >= 1e3) return Math.round(v / 1e3) + 'k'
      return String(v)
    }

    function ago(ts) {
      const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
      if (s < 60) return `${s} с`
      const m = Math.round(s / 60)
      if (m < 60) return `${m} мин`
      const hrs = Math.round(m / 60)
      return hrs < 24 ? `${hrs} ч` : `${Math.round(hrs / 24)} дн`
    }

    // The --rc-* tokens default to the shell's own palette, so the pill matches the
    // host theme without borrowing tidewatch's private variables.
    const CSS = `
      .rc-wrap{position:fixed;right:16px;bottom:96px;z-index:1001;display:flex;flex-direction:column;align-items:flex-end;gap:6px;
        --rc-line:var(--border,rgba(127,127,127,.28));--rc-surface:var(--card,var(--background,#1b1b1b));
        --rc-text:var(--foreground,#eaeaea);--rc-muted:var(--muted-foreground,#9a9a9a);--rc-accent:var(--accent,#6ea8fe);
        --rc-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--rc-shadow:0 2px 12px rgba(0,0,0,.18)}
      .rc-pill{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 12px;border:1px solid var(--rc-line);
        border-radius:999px;background:var(--rc-surface);color:var(--rc-text);font-family:inherit;font-size:11.5px;
        font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;user-select:none;box-shadow:var(--rc-shadow);
        transition:border-color .16s ease}
      .rc-pill:hover{border-color:var(--rc-accent)}
      .rc-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--rc-accent);color:var(--rc-accent);
        box-shadow:0 0 0 3px color-mix(in srgb,var(--rc-accent) 18%,transparent)}
      .rc-name{font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--rc-muted)}
      .rc-num{font-family:var(--rc-mono);font-size:11px;font-weight:600;color:var(--rc-text);font-variant-numeric:tabular-nums}
      .rc-dim{font-family:var(--rc-mono);font-size:10px;color:var(--rc-muted);font-variant-numeric:tabular-nums}
      .rc-panel{width:322px;max-width:calc(100vw - 24px);box-sizing:border-box;padding:10px 12px 9px;border:1px solid var(--rc-line);
        border-radius:18px;background:var(--rc-surface);background:color-mix(in srgb,var(--rc-surface) 92%,transparent);
        -webkit-backdrop-filter:blur(20px) saturate(1.4);backdrop-filter:blur(20px) saturate(1.4);box-shadow:var(--rc-shadow);
        color:var(--rc-text);font-size:11.5px;text-align:left;white-space:normal;max-height:min(60vh,420px);overflow-y:auto}
      .rc-head{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px}
      .rc-eyebrow{font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--rc-muted)}
      .rc-thr{font-family:var(--rc-mono);font-size:9.5px;color:var(--rc-muted);white-space:nowrap}
      .rc-note{margin:0 0 7px;font-size:10px;line-height:1.45;color:var(--rc-muted)}
      .rc-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:3px 8px;border-radius:7px}
      .rc-row:nth-child(even){background:color-mix(in srgb,var(--rc-line) 22%,transparent)}
      .rc-row code{font-family:var(--rc-mono);font-size:10px;color:var(--rc-text)}
      .rc-row span{font-family:var(--rc-mono);font-size:9.5px;color:var(--rc-muted);white-space:nowrap}
      .rc-empty{padding:3px 8px;font-size:10px;color:var(--rc-muted)}
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

    // Anchor above the tidewatch chip when it is on screen, so the two pills read
    // as one card. Falls back to the corner while the chip is missing or moving.
    function useAnchor(ref) {
      useEffect(() => {
        let timer = 0
        const place = () => {
          const el = ref.current
          if (el) {
            const chip = document.querySelector('.tw-chip')
            if (chip) {
              const r = chip.getBoundingClientRect()
              el.style.right = `${Math.max(8, window.innerWidth - r.right)}px`
              el.style.top = `${Math.max(8, r.top - 6 - el.offsetHeight)}px`
              el.style.bottom = 'auto'
            } else {
              el.style.right = '16px'
              el.style.top = 'auto'
              el.style.bottom = '96px'
            }
          }
          timer = window.setTimeout(place, 500)
        }
        place()
        window.addEventListener('resize', place)
        return () => {
          window.clearTimeout(timer)
          window.removeEventListener('resize', place)
        }
      }, [ref])
    }

    function Pill() {
      const T = useT()
      const data = useStats()
      const [open, setOpen] = useState(false)
      const ref = useRef(null)
      useAnchor(ref)
      if (!data) return null
      const recent = data.recent || []
      return h(
        'div',
        { className: 'rc-wrap', ref },
        open
          ? h(
              'div',
              { className: 'rc-panel' },
              h(
                'div',
                { className: 'rc-head' },
                h('span', { className: 'rc-eyebrow' }, T('recent')),
                h('span', { className: 'rc-thr' }, T('look', { n: nf(data.threshold) })),
              ),
              h('p', { className: 'rc-note' }, T('hint')),
              recent.length === 0
                ? h('div', { className: 'rc-empty' }, T('empty'))
                : recent.map((e, i) =>
                    h(
                      'div',
                      { className: 'rc-row', key: i },
                      h('code', null, `${e.tool || 'tool'} #${e.id}`),
                      h('span', null, `${nf(e.chars)} · ${ago(e.ts)}`),
                    ),
                  ),
            )
          : null,
        h(
          'div',
          { className: 'rc-pill', onClick: () => setOpen(!open), title: T('hint') },
          h('span', { className: 'rc-dot' }),
          h('span', { className: 'rc-name' }, T('strip')),
          data.offloaded
            ? h('span', { className: 'rc-num' }, nf(data.offloaded))
            : h('span', { className: 'rc-dim' }, T('none')),
          data.offloaded ? h('span', { className: 'rc-dim' }, `· ${kk(data.tokensSaved)} tok`) : null,
          data.recalls ? h('span', { className: 'rc-dim' }, `· ↺${nf(data.recalls)}`) : null,
        ),
      )
    }

    function mount(ctx) {
      if (!document.getElementById('rc-css')) {
        const s = document.createElement('style')
        s.id = 'rc-css'
        s.textContent = CSS
        document.head.appendChild(s)
      }
      // Root-level slot: it exists on the hero screen too, unlike composer.dock.
      ctx.inject(['slots'], (scope) => {
        const slots = scope.slots
        if (!slots) return
        slots.inject('shell.overlay', () =>
          slots
            .register({ name: 'shell.overlay', id: 'dsh-recall-pill', order: 100, inject: () => ({}) }, Pill)
            .catch((e) => console.error('[recall] overlay slot failed:', e && (e.message || e))),
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

    module.exports = { inject: ['slots'], apply }
    return module.exports
  },
})
