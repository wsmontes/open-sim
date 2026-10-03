import {expect,test} from 'vitest';
import {createPlayHost} from '../tools/play-host';
import {parseCommand} from '../src/surfaces/text/parse';
import {prefeituraLines} from '../src/surfaces/text/render';
import {economyPanel} from '../src/presentation/words';
import type {CityEconomy} from '../src/core/model';

const ORIGIN = {x: 0, y: 0};

// The economy panel the terminal's "prefeitura" prints is the same words the canvas HUD shows (src/presentation/words).
test('the economy panel is the shared words, including the sign on the monthly balance and the crisis line', () => {
 const economy: CityEconomy = {
  taxPercent: 14, servicesPercent: 50, serviceLevel: 0.5,
  demand: {residential: 200, commercial: -100, industrial: 0},
  landValueAverage: 1234, monthly: {revenue: 2769, expense: 3155, net: -386},
  debt: 10000, interestRate: 3.5, rating: 'B',
  crisis: 'A cidade gastou mais do que arrecadou e o caixa acabou.',
 };
 const panel = Object.fromEntries(economyPanel(economy));
 expect(panel['Imposto']).toBe('14%');
 expect(panel['Serviços']).toBe('50%');
 expect(panel['Saldo/mês']).toBe('-386'); // net carries its own sign; positive would read "+N"
 expect(panel['Dívida']).toBe('10.000'); // grouped once, so the HUD and the terminal never disagree
 expect(panel['Classificação']).toBe('B');
 expect(panel['Demanda (R/C/I)']).toBe('200 / -100 / 0');
 // A view's economy, run through the real client, reaches the lines with the crisis flagged.
 const lines = prefeituraLines({place: 'Lisboa', stats: {money: 0, population: 380, economy}} as never);
 expect(lines[0]).toBe('[Prefeitura de Lisboa]');
 expect(lines.some(line => line.startsWith('  Caixa: 0'))).toBe(true);
 expect(lines.some(line => line.includes('⚠') && line.includes('caixa acabou'))).toBe(true);
});

// "prefeitura" is a view-only command: it shows numbers, it never changes the world.
test('prefeitura parses to a view-only command with no intentions', () => {
 expect(parseCommand('prefeitura', ORIGIN)).toEqual({intents: [], show: 'prefeitura'});
 expect(parseCommand('economia', ORIGIN)).toEqual({intents: [], show: 'prefeitura'});
});

// The surface teaches the valid range before the world has to refuse it (the bare "fora do intervalo" a player hit).
test('policy levers are hinted with their range at the surface before reaching the world', () => {
 expect(parseCommand('imposto 25', ORIGIN)).toEqual({error: 'Imposto de 0 a 20: 25 está fora.'});
 expect(parseCommand('imposto -5', ORIGIN)).toEqual({error: 'Imposto de 0 a 20: -5 está fora.'});
 expect(parseCommand('servicos 10', ORIGIN)).toEqual({error: 'Serviços de 50 a 150: 10 está fora.'});
 expect(parseCommand('emprestar 999999', ORIGIN)).toEqual({error: 'Empréstimo até 100000: 999999 é demais.'});
 // Values inside the range still become the policy intention they always were.
 expect(parseCommand('imposto 12', ORIGIN)).toEqual({intents: [{do: 'policy', tax: 12}]});
 expect(parseCommand('servicos 120', ORIGIN)).toEqual({intents: [{do: 'policy', services: 120}]});
 expect(parseCommand('emprestar', ORIGIN)).toEqual({intents: [{do: 'policy', borrow: 10000}]});
});

// The real client's view carries a populated economy a fresh terminal can read at once.
test('a fresh city exposes a readable economy through the view', async () => {
 const host = createPlayHost();
 const opened = await host.open();
 await opened.client.start();
 await opened.client.idle();
 const lines = prefeituraLines(opened.client.view());
 expect(lines[0]).toContain('Prefeitura');
 expect(lines.some(line => line.startsWith('  Imposto: 9%'))).toBe(true);
 expect(lines.some(line => line.startsWith('  Classificação: A'))).toBe(true);
 opened.client.stop();
});
