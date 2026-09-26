// Browser half: the configuration page for this bundle's own row.
//
// A bundle renders its own settings on the Plugins page rather than in Settings,
// through one of the page's keyed slots. This row's page is `plugins.row.config`,
// keyed `<package name>#<row id>`; the page draws the title, icon, and crumb, and
// hands the entry a `form` whose `mutate` is the only thing that writes.
//
// Two facts decide what this form can offer:
//
// 1. The layer switches (memory / rules / skills / memoryLayout) belong to the
//    PROJECT, in `.dsh/workspace.yml`. The Client has no generic file-write
//    service, so a browser page cannot edit them. This form therefore edits the
//    profile-level knobs — the byte budgets — and says where the project switches
//    live instead of pretending to own them.
// 2. A write this form makes can be REFUSED when a higher-priority layer already
//    sets the field: `mutate` then answers false and reloads Host state. The form
//    reports that refusal rather than silently snapping the value back.
//
// The bundle is hand-written in the module-loader format the template uses, so it
// needs no client build toolchain: React arrives through `require('react')`.
window.__ModuleLoader__.load({
  id: '@jinngoo/dsh-workspace-conventions',
  factory(require) {
    const React = require('react');

    /** The row's slot key: the bundle's package name, a hash, and the row id. */
    const SLOT_KEY = '@jinngoo/dsh-workspace-conventions#workspace-conventions';
    /** The Host settings namespace is the Loader entry id of the row. */
    const NAMESPACE = 'include:workspace-conventions';

    const FIELDS = [
      {
        name: 'indexPromptBytes',
        label: '索引段落上限',
        hint: '每轮注入的记忆索引字节上限；超出部分仍可由 memory_read 取回。',
        fallback: 7000,
      },
      {
        name: 'rulesPromptBytes',
        label: '规则段落总预算',
        hint: '整段规则注入的字节上限。常驻册优先；已触发但放不下的条件册降级为标题 + rule_read 指针。',
        fallback: 49152,
      },
      {
        name: 'ruleFileBytes',
        label: '单册上限',
        hint: '单册规则的字节上限，对齐 WorkBuddy 约 16 KB 的契约。',
        fallback: 16384,
      },
    ];

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const inputStyle = {
      width: '10rem',
      padding: '4px 8px',
      boxSizing: 'border-box',
      fontFamily: MONO,
      fontSize: '13px',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-base)',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '6px',
    };
    const buttonStyle = {
      padding: '5px 14px',
      fontSize: '13px',
      color: '#fff',
      background: 'var(--dsw-alias-brand-primary)',
      border: '1px solid transparent',
      borderRadius: '6px',
      cursor: 'pointer',
    };
    const labelStyle = { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontWeight: 500 };
    const hintStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.5 };
    const noteStyle = { ...hintStyle, marginTop: '4px' };

    /** The stored user layer's own keys; a present key is an override, value-equal or not. */
    function overriddenKeys(user) {
      if (user === null || typeof user !== 'object' || Array.isArray(user)) return [];
      return Object.keys(user);
    }

    function currentOf(snapshot, field) {
      const value = snapshot.value;
      if (value !== null && typeof value === 'object' && typeof value[field.name] === 'number') return value[field.name];
      return field.fallback;
    }

    function ConfigFormPage(props) {
      // The page also asks for a `summary` view; only the page view is a form.
      if (props.view !== 'page' || props.form === undefined) return null;
      const form = props.form;

      const snapshot = React.useSyncExternalStore(
        (listener) => form.subscribe(listener),
        () => form.getSnapshot(),
        () => form.getSnapshot(),
      );

      const [draft, setDraft] = React.useState(() => Object.fromEntries(FIELDS.map((f) => [f.name, String(currentOf(form.getSnapshot(), f))])));
      const [outcome, setOutcome] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      // Reload the fields when the Host's accepted values move (a save landing, a
      // refused write's recovery read, or an edit made elsewhere).
      const revision = snapshot.revision;
      const accepted = React.useMemo(
        () => Object.fromEntries(FIELDS.map((f) => [f.name, String(currentOf(snapshot, f))])),
        [revision, snapshot.status],
      );
      React.useEffect(() => { setDraft(accepted); setOutcome(null); }, [accepted]);

      const dirty = FIELDS.filter((f) => draft[f.name] !== undefined && draft[f.name] !== accepted[f.name]);
      const overridden = overriddenKeys(snapshot.user);

      const save = async () => {
        setBusy(true);
        setOutcome(null);
        const ops = [];
        for (const field of dirty) {
          const raw = draft[field.name].trim();
          const parsed = Number(raw);
          if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
            setOutcome({ tone: 'error', text: `${field.label}：需要一个非负整数，收到「${raw}」` });
            setBusy(false);
            return;
          }
          ops.push({ op: 'set', path: [field.name], value: parsed });
        }

        let acceptedAll = true;
        try {
          acceptedAll = await form.mutate(ops);
        } catch (error) {
          setOutcome({ tone: 'error', text: `写入失败：${error instanceof Error ? error.message : String(error)}` });
          setBusy(false);
          return;
        }

        setBusy(false);
        setOutcome(acceptedAll
          ? { tone: 'ok', text: `已保存 ${ops.length} 项。` }
          : {
              tone: 'warn',
              text: 'Host 拒绝了这次写入：更高优先级的层（例如 profile 的 cordis.patch.yml）已经设定了这些字段，表单值不会生效。',
            });
      };

      if (snapshot.status === 'unavailable' || snapshot.mode === 'memory') {
        return React.createElement('div', { style: hintStyle }, '当前部署不向本页提供可写的配置（远程浏览器或配置只存在于内存中）。');
      }
      if (snapshot.status === 'loading') {
        return React.createElement('div', { style: hintStyle }, '正在读取配置…');
      }

      const rows = FIELDS.map((field) => React.createElement('div', {
        key: field.name,
        style: { display: 'grid', gridTemplateColumns: '13rem 1fr', gap: '12px', alignItems: 'start', padding: '12px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' },
      },
      React.createElement('div', null,
        React.createElement('div', { style: labelStyle }, field.label),
        React.createElement('div', { style: { ...hintStyle, fontFamily: MONO, marginTop: '2px' } }, field.name),
      ),
      React.createElement('div', null,
        React.createElement('input', {
          type: 'number',
          min: 0,
          step: 1,
          value: draft[field.name] ?? '',
          disabled: busy || !snapshot.writable,
          'aria-label': field.label,
          onChange: (event) => setDraft((prev) => ({ ...prev, [field.name]: event.target.value })),
          style: inputStyle,
        }),
        overridden.includes(field.name)
          ? React.createElement('div', { style: noteStyle }, '该字段已被 profile 覆盖——在此保存不会生效。')
          : null,
        React.createElement('div', { style: noteStyle }, field.hint),
      )));

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
        rows,
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', paddingTop: '14px', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
          React.createElement('button', {
            type: 'button',
            disabled: busy || dirty.length === 0 || !snapshot.writable,
            onClick: save,
            style: { ...buttonStyle, opacity: busy || dirty.length === 0 || !snapshot.writable ? 0.5 : 1, cursor: busy || dirty.length === 0 ? 'default' : 'pointer' },
          }, busy ? '保存中…' : '保存'),
          outcome === null ? null : React.createElement('span', {
            role: outcome.tone === 'error' ? 'alert' : 'status',
            style: {
              fontSize: '12px',
              color: outcome.tone === 'error'
                ? 'var(--dsw-alias-state-error-primary)'
                : outcome.tone === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)',
            },
          }, outcome.text),
        ),
        React.createElement('div', { style: { ...hintStyle, marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--dsw-alias-border-l1)', lineHeight: 1.7 } },
          React.createElement('div', null, '这三项是 profile 级默认值，对所有工作区生效。'),
          React.createElement('div', null, '按项目开关记忆 / 规则 / 技能（以及记忆布局）请编辑该项目的 ', React.createElement('code', { style: { fontFamily: MONO } }, '.dsh/workspace.yml'), '；该文件在首次使用时会被自动创建，本页没有写它的权限。'),
        ),
      );
    }

    return {
      name: '@jinngoo/dsh-workspace-conventions',
      inject: ['slots'],
      apply(ctx) {
        // `configForms` is optional: without it the Host half still runs, so the
        // page simply never appears rather than the whole plugin failing.
        ctx.inject(['configForms'], (scoped) => {
          const forms = scoped.configForms;
          if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return;

          const form = forms.get(NAMESPACE);
          scoped.effect(() => forms.whileServed([NAMESPACE], () => scoped.slots.inject('plugins.row.config', () => scoped.slots.register({
            name: 'plugins.row.config',
            key: SLOT_KEY,
          }, (props) => React.createElement(ConfigFormPage, props)))), 'workspace-conventions: row configuration page');
        });
      },
    };
  },
});
