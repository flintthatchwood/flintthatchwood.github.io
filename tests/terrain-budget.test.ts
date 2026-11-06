import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TERRAIN_TRIANGLES, TerrainBudget, worldBudget } from '../src/terrain-budget.js';

test('paired terrain limits retain defaults and scale through the exact 32x ceiling', () => {
    for (const multiplier of [1, 2, 4, 8, 16, 32]) {
        const limits = worldBudget(multiplier);
        assert.equal(limits.triangles, multiplier * 1_000_000);
        assert.equal(limits.bytes, multiplier * 96 * 1024 * 1024);
        assert.equal(limits.cubeTriangles, Math.max(4_000_000, limits.triangles));
    }
    for (const invalid of [0, -1, 3, 64, NaN, Infinity])
        assert.throws(() => worldBudget(invalid), /Terrain budget multiplier/);
});

test('changing adaptive limits resets frame samples and preserves base coverage', () => {
    const budget = new TerrainBudget(700_000);
    for (let i = 0; i < 100; i++) budget.sample(i * 35, true);
    budget.setMultiplier(32);
    assert.equal(budget.triangles, 32_000_000);
    budget.sample(3500, true);
    assert.equal(budget.triangles, 32_000_000);
    for (let i = 0; i < 400; i++) budget.sample(4000 + i * 16, true);
    assert.equal(budget.triangles, 32_000_000);
    budget.setMultiplier(1);
    assert.equal(budget.triangles, 1_000_000);
    for (let i = 0; i < 1000; i++) budget.sample(20000 + i * 35, true);
    assert.equal(budget.triangles, 700_000);
    assert.throws(() => budget.setMultiplier(64), /Terrain budget multiplier/);
    assert.equal(budget.triangles, 700_000);
});

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
