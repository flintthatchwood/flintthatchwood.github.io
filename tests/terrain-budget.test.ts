import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TERRAIN_TRIANGLES, TerrainBudget } from '../src/terrain-budget.js';

test('terrain budget grows only with detail demand and sustained frame-time headroom', () => {
    const budget = new TerrainBudget(1000);
    let now = 0;
    const frames = (ms: number, needsDetail: boolean) => {
        for (let i = 0; i < 121; i++) budget.sample((now += ms), needsDetail);
    };
    frames(16.7, false);
    assert.equal(budget.triangles, 1_000_000);
    frames(16.7, true);
    assert.equal(budget.triangles, 1_200_000);
    for (let i = 0; i < 20; i++) frames(16.7, true);
    assert.equal(budget.triangles, MAX_TERRAIN_TRIANGLES);
});

test('slow frames shrink the budget without evicting complete base coverage', () => {
    const budget = new TerrainBudget(700_000);
    for (let i = 0; i < 1000; i++) budget.sample(i * 35, true);
    assert.equal(budget.triangles, 700_000);
});

test('suspended-tab gaps do not count as slow rendering samples', () => {
    const budget = new TerrainBudget(1000);
    for (let i = 0; i < 400; i++) budget.sample(i * 1000, true);
    assert.equal(budget.triangles, 1_000_000);
});
