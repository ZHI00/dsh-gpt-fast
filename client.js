window.__ModuleLoader__.load({
  id: 'dsh-gpt-fast-local',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PKG = 'dsh-gpt-fast-local';
    const NS = 'gpt-fast-controls';
    const dicts = {
      zh: {
        title: 'Fast 模式', enabled: '已开启', disabled: '已关闭', ready: '监听器已注册', unavailable: '监听器未就绪',
        injections: '注入次数', skipped: '未处理次数', models: '适用模型', loading: '正在读取状态', failed: '状态读取失败',
        retry: '重试', saving: '正在更新', commands: '命令', on: '开启 Fast', off: '关闭 Fast',
        status: '查看状态', proxyStatus: '运行状态', changeFailed: '更新失败，请重试', hint: '注入次数不代表上游实际服务等级。', switchLabel: 'Fast 模式'
      },
      en: {
        title: 'Fast mode', enabled: 'On', disabled: 'Off', ready: 'Request handler ready', unavailable: 'Request handler unavailable',
        injections: 'Injections', skipped: 'Unhandled', models: 'Models', loading: 'Loading status', failed: 'Could not load status',
        retry: 'Retry', saving: 'Updating', commands: 'Commands', on: 'Enable Fast', off: 'Disable Fast',
        status: 'Show status', proxyStatus: 'Handler status', changeFailed: 'Update failed. Try again.', hint: 'Injections do not confirm the upstream service tier.', switchLabel: 'Fast mode'
      }
    };

    function endpoint(action) {
      return new URL(`api/dsh-gpt-fast/${action}`, document.baseURI).pathname;
    }

    function Controls({ t }) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      const [pending, setPending] = React.useState(false);
      const alive = React.useRef(true);
      const busy = React.useRef(false);
      const sequence = React.useRef(0);

      async function refresh() {
        if (busy.current) return;
        const id = ++sequence.current;
        try {
          const response = await fetch(endpoint('status'), { credentials: 'same-origin', cache: 'no-store' });
          if (!response.ok) throw new Error('status');
          const value = await response.json();
          if (alive.current && id === sequence.current) { setData(value); setError(''); }
        } catch {
          if (alive.current && id === sequence.current) setError(t('failed'));
        }
      }

      async function change() {
        if (busy.current || !data?.ready) return;
        busy.current = true;
        sequence.current++;
        setPending(true);
        try {
          const response = await fetch(endpoint('enabled'), {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !data.enabled })
          });
          if (!response.ok) throw new Error('change');
          const value = await response.json();
          if (alive.current) { setData(value); setError(''); }
        } catch {
          if (alive.current) setError(t('changeFailed'));
        } finally {
          busy.current = false;
          if (alive.current) setPending(false);
        }
      }

      React.useEffect(() => {
        alive.current = true;
        refresh();
        const timer = setInterval(refresh, 4000);
        return () => { alive.current = false; sequence.current++; clearInterval(timer); };
      }, []);

      const row = (label, value) => h('div', { key: label, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, flexWrap: 'wrap', fontSize: 13 } },
        h('span', { style: { opacity: 0.7 } }, label), h('span', { style: { overflowWrap: 'anywhere', textAlign: 'right' } }, value));
      const command = (text, label) => h('div', { key: text, style: { display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 13 } },
        h('code', { style: { minWidth: 140, fontSize: 12 } }, text), h('span', { style: { opacity: 0.7 } }, label));
      const switchDisabled = pending || !data?.ready || Boolean(error);
      return h('section', { 'data-gpt-fast-controls': '', style: { display: 'grid', gap: 14, paddingTop: 4 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 } },
          h('div', { style: { display: 'grid', gap: 4 } },
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, t('title')),
            h('div', { style: { fontSize: 12, opacity: 0.7 }, 'aria-live': 'polite' }, pending ? t('saving') : !data ? t('loading') : data.enabled ? t('enabled') : t('disabled'))),
          h('button', {
            type: 'button', role: 'switch', 'aria-label': t('switchLabel'), 'aria-checked': Boolean(data?.enabled),
            disabled: switchDisabled, onClick: change,
            style: { width: 38, height: 22, padding: 2, borderRadius: 999, border: '1px solid rgba(127,127,127,0.45)', background: data?.enabled ? '#16a36a' : 'rgba(127,127,127,0.32)', cursor: switchDisabled ? 'not-allowed' : 'pointer', opacity: switchDisabled ? 0.55 : 1, display: 'flex', alignItems: 'center', justifyContent: data?.enabled ? 'flex-end' : 'flex-start', flexShrink: 0 }
          }, h('span', { style: { width: 16, height: 16, borderRadius: '50%', background: '#fff', display: 'block' } }))
        ),
        error ? h('div', { role: 'alert', style: { fontSize: 13, color: '#e17c6d' } }, error, ' ', h('button', { type: 'button', onClick: refresh, style: { background: 'transparent', color: 'inherit', border: 0, textDecoration: 'underline', cursor: 'pointer', padding: 0 } }, t('retry'))) : null,
        data ? h('div', { style: { display: 'grid', gap: 8 } },
          row(t('proxyStatus'), data.ready ? t('ready') : (data.error || t('unavailable'))),
          row(t('injections'), String(data.injections)),
          row(t('skipped'), String(data.skipped ?? 0)),
          row(t('models'), data.models?.join(', ') || '-'),
          h('div', { style: { fontSize: 12, opacity: 0.6 } }, t('hint'))
        ) : null,
        h('div', { style: { display: 'grid', gap: 7, paddingTop: 3 } },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('commands')),
          command('/gpt-fast on', t('on')), command('/gpt-fast off', t('off')), command('/gpt-fast status', t('status')))
      );
    }

    return {
      name: PKG,
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dicts), 'gpt-fast: locale');
        const fallback = ctx.locale.bind(NS);
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register(
          { name: 'plugins.detail.section', id: 'gpt-fast-controls', order: 50, locale: NS },
          ({ t, subject }) => {
            const pkg = typeof subject?.pkg === 'string' ? subject.pkg : subject?.pkg?.name;
            return subject?.kind === 'bundle' && pkg === PKG ? h(Controls, { t: t ?? fallback }) : null;
          }
        ));
      }
    };
  }
});
