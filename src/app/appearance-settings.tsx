// Appearance section of the settings page: theme mode, accent, density, radius, motion and feedback timing.
// Every control writes through useTheme().update, which applies instantly and debounce-saves to the account.
import type { CSSProperties } from 'react';
import { useI18n } from '../i18n';
import type { UiSettings } from '../ui-settings';
import { useFeedback } from './feedback';
import { rangeFill } from './select';
import { ACCENT_SPECS, useTheme } from './theme';

type Option<T extends string> = readonly [T, string];

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<Option<T>>; onChange: (next: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([id, text]) => (
        <button
          type="button"
          key={id}
          className={value === id ? 'on' : ''}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function SwitchRow({ title, desc, checked, onChange }: { title: string; desc: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        <small>{desc}</small>
      </div>
      <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={title} onClick={() => onChange(!checked)} />
    </div>
  );
}

export function AppearanceSettings() {
  const { t } = useI18n();
  const { settings, update, reset, saving } = useTheme();
  const { notify } = useFeedback();

  const customActive = settings.accentMode === 'custom';
  const seconds = Math.round(settings.feedbackDurationMs / 1000);

  const resetAll = () => {
    const previous = settings;
    reset();
    notify({
      title: t('appearance.resetDone'),
      tone: 'info',
      actions: [{ label: t('feedback.undo'), onClick: () => update(previous) }],
    });
  };

  const statusText = saving === 'saving'
    ? t('appearance.saving')
    : saving === 'saved'
      ? t('appearance.saved')
      : saving === 'error'
        ? t('appearance.error')
        : '';

  return (
    <section className="appearance-settings" aria-labelledby="appearance-title">
      <h2 id="appearance-title" style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 600 }}>{t("appearance.title")}</h2>
      <div className="settings-grid">
        <div className="settings-card">
          <h3>{t('appearance.themeTitle')}</h3>
          <p>{t('appearance.desc')}</p>
          <Segmented<UiSettings['mode']>
            label={t('appearance.mode')}
            value={settings.mode}
            onChange={(mode) => update({ mode })}
            options={[
              ['light', t('appearance.mode.light')],
              ['dark', t('appearance.mode.dark')],
              ['system', t('appearance.mode.system')],
            ]}
          />
          <div style={{ height: 12 }} />
          <h3>{t('appearance.accent')}</h3>
          <div className="swatch-row" role="group" aria-label={t('appearance.accent')}>
            {ACCENT_SPECS.map((spec) => {
              const active = settings.accentMode === 'preset' && settings.accentPreset === spec.id;
              const label = t(`appearance.accent.${spec.id}`);
              return (
                <button
                  type="button"
                  key={spec.id}
                  className={`swatch${active ? ' active' : ''}`}
                  style={{ background: spec.swatch, '--swatch-color': spec.swatch } as CSSProperties}
                  aria-label={label}
                  aria-pressed={active}
                  title={label}
                  onClick={() => update({ accentMode: 'preset', accentPreset: spec.id })}
                />
              );
            })}
            <label
              className={`swatch${customActive ? ' active' : ''}`}
              title={t('appearance.customAccent')}
              style={{ background: settings.accentCustom, '--swatch-color': settings.accentCustom, overflow: 'hidden' } as CSSProperties}
            >
              <input
                type="color"
                value={settings.accentCustom}
                aria-label={t('appearance.customAccent')}
                onChange={(e) => update({ accentMode: 'custom', accentCustom: e.target.value })}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, border: 0, padding: 0, cursor: 'pointer' }}
              />
            </label>
          </div>
        </div>

        <div className="settings-card">
          <h3>{t('appearance.layoutTitle')}</h3>
          <p>{t('appearance.layoutDesc')}</p>
          <div className="setting-row">
            <div><strong>{t('appearance.density')}</strong></div>
            <Segmented<UiSettings['density']>
              label={t('appearance.density')}
              value={settings.density}
              onChange={(density) => update({ density })}
              options={[
                ['comfortable', t('appearance.density.comfortable')],
                ['compact', t('appearance.density.compact')],
              ]}
            />
          </div>
          <div className="setting-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}>
            <div><strong>{t('appearance.radius')}</strong></div>
            <div className="range-row">
              <input
                type="range"
                min={4}
                max={16}
                step={1}
                value={settings.radius}
                aria-label={t('appearance.radius')}
                style={{ ['--fill' as any]: rangeFill(settings.radius, 4, 16) } as CSSProperties}
                onChange={(e) => update({ radius: Number(e.target.value) })}
              />
              <output style={{ fontVariantNumeric: 'tabular-nums' }}>{settings.radius}px</output>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <strong>{t('appearance.pdfViewer')}</strong>
              <small>{t('appearance.pdfViewerDesc')}</small>
            </div>
            <Segmented<UiSettings['pdfViewer']>
              label={t('appearance.pdfViewer')}
              value={settings.pdfViewer}
              onChange={(pdfViewer) => update({ pdfViewer })}
              options={[
                ['adobe', t('pdf.adobe')],
                ['pdfjs', t('pdf.classic')],
              ]}
            />
          </div>
        </div>

        <div className="settings-card">
          <h3>{t('appearance.motionTitle')}</h3>
          <SwitchRow
            title={t('appearance.reduceMotion')}
            desc={t('appearance.reduceMotionDesc')}
            checked={settings.reduceMotion}
            onChange={(reduceMotion) => update({ reduceMotion })}
          />
          <SwitchRow
            title={t('appearance.disableMotion')}
            desc={t('appearance.disableMotionDesc')}
            checked={settings.disableMotion}
            onChange={(disableMotion) => update({ disableMotion })}
          />
          <div className="setting-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}>
            <div>
              <strong>{t('appearance.feedback')}</strong>
              <small>{t('appearance.feedbackDesc')}</small>
            </div>
            <div className="range-row">
              <input
                type="range"
                min={3}
                max={10}
                step={1}
                value={seconds}
                aria-label={t('appearance.feedback')}
                style={{ ['--fill' as any]: rangeFill(seconds, 3, 10) } as CSSProperties}
                onChange={(e) => update({ feedbackDurationMs: Number(e.target.value) * 1000 })}
              />
              <output style={{ fontVariantNumeric: 'tabular-nums' }}>{t('appearance.seconds', { count: seconds })}</output>
            </div>
          </div>
        </div>

        <div className="settings-card" style={{ gridColumn: '1 / -1' }}>
          <h3>{t('appearance.preview')}</h3>
          <div
            aria-live="off"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 10,
              padding: 14,
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
            }}
          >
            <button type="button" className="primary">{t('appearance.previewPrimary')}</button>
            <button type="button" className="soft">{t('appearance.previewSoft')}</button>
            <span className="badge">{t('appearance.previewBadge')}</span>
            <button
              type="button"
              className="soft"
              onClick={() => notify({ title: t('appearance.previewTitle'), detail: t('appearance.previewDetail'), tone: 'success' })}
            >
              {t('appearance.previewNotice')}
            </button>
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              marginTop: 12,
            }}
          >
            <span role="status" aria-live="polite" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>{statusText}</span>
            <button type="button" className="soft" onClick={resetAll}>{t('appearance.reset')}</button>
          </div>
        </div>
      </div>
    </section>
  );
}
