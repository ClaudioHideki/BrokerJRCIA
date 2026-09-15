import { describe, expect, it } from 'vitest';

type UiTokens = {
  color: {
    primary: string;
    secondary: string;
    highlight: string;
    heading: string;
  };
  typography: {
    fontFamily: { sans: string };
    fontSize: { xs: string; sm: string; base: string; display: string };
    fontWeight: { regular: number; semibold: number; bold: number; black: number };
    lineHeight: { tight: number; normal: number };
  };
  spacing: { xs: string; sm: string; md: string; lg: string; xl: string; xxl: string };
  radius: { sm: string; md: string; lg: string; pill: string };
  border: { width: string; subtle: string; brand: string };
  shadow: { sm: string; md: string; lg: string };
  state: {
    disabledOpacity: number;
    primaryHover: string;
    success: { text: string; surface: string };
    pending: { text: string; surface: string };
    warning: { text: string; surface: string };
    danger: { text: string; surface: string };
    neutral: { text: string; surface: string };
  };
};

type UiModule = {
  jrcTokens?: UiTokens;
  jrcCssVariables?: Record<string, string>;
};

async function loadTokens(): Promise<UiModule> {
  try {
    const moduleUrl = new URL('../src/tokens.js', import.meta.url).href;
    return (await import(moduleUrl)) as UiModule;
  } catch {
    return {};
  }
}

describe('tokens JRC', () => {
  it('expõe as cores de marca aprovadas', async () => {
    const { jrcTokens: tokens } = await loadTokens();

    expect(tokens?.color).toMatchObject({
      primary: '#007392',
      secondary: '#2CB4F1',
      highlight: '#FDD704',
      heading: '#153243',
    });
  });

  it('expõe tipografia, espaçamento, bordas, raios, sombras e estados reutilizáveis', async () => {
    const { jrcTokens: tokens } = await loadTokens();

    expect(tokens).toMatchObject({
      typography: {
        fontFamily: { sans: expect.stringContaining('Inter') },
        fontSize: { xs: '0.78rem', sm: '0.85rem', base: '1rem', display: '2.3rem' },
        fontWeight: { regular: 400, semibold: 700, bold: 800, black: 900 },
        lineHeight: { tight: 1.15, normal: 1.5 },
      },
      spacing: { xs: '0.25rem', sm: '0.5rem', md: '0.75rem', lg: '1rem', xl: '1.5rem', xxl: '2.5rem' },
      radius: { sm: '0.35rem', md: '0.55rem', lg: '0.75rem', pill: '999px' },
      border: { width: '1px', subtle: '#D8E1E4', brand: 'rgb(0 115 146 / 18%)' },
      shadow: {
        sm: '0 8px 24px rgb(21 50 67 / 6%)',
        md: '0 10px 24px rgb(21 50 67 / 9%)',
        lg: '0 16px 40px rgb(21 50 67 / 12%)',
      },
      state: {
        disabledOpacity: 0.6,
        primaryHover: '#005F79',
        success: { text: '#05603A', surface: '#E9F8F0' },
        pending: { text: '#075985', surface: '#E8F6FC' },
        warning: { text: '#7A4D00', surface: '#FFF6D6' },
        danger: { text: '#8D2118', surface: '#FFF1F0' },
        neutral: { text: '#334E5A', surface: '#EDF2F4' },
      },
    });
  });

  it('publica variáveis CSS equivalentes para consumidores web', async () => {
    const { jrcCssVariables: variables } = await loadTokens();

    expect(variables).toMatchObject({
      '--jrc-primary': '#007392',
      '--jrc-font-family-sans': expect.stringContaining('Inter'),
      '--jrc-space-lg': '1rem',
      '--jrc-radius-lg': '0.75rem',
      '--jrc-border-subtle': '#D8E1E4',
      '--jrc-shadow-lg': '0 16px 40px rgb(21 50 67 / 12%)',
      '--jrc-state-danger-surface': '#FFF1F0',
    });
  });
});
