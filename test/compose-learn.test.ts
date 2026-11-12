import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeStartRisk, envFileFlags, envFileToLearn, learnFromCompose } from '../src/engine/compose-learn.js';
import { findCommands, fromTheRead } from '../src/engine/find-commands.js';

/**
 * What a first read learns from a part's compose files when squad-kit starts the part on this computer: the env file
 * Compose gives the app, and never a compose start that keeps the daily stack's names. A made-up shop API (.NET) whose
 * daily stack runs in Docker Compose, and a made-up booking web app. Nothing here runs Docker.
 */

const DAILY = `name: shop
services:
  api:
    build:
      context: ./src/Shop.Api
    container_name: shop-api
    env_file:
      - .env.dev
    ports: ["8080:80"]
  app.db:
    image: mongo:7
    container_name: shop-mongo
    ports: ["27018:27017"]
`;

const WEB_PROJECT = '<Project Sdk="Microsoft.NET.Sdk.Web">\n  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n</Project>\n';
const TEST_PROJECT = '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /></ItemGroup>\n</Project>\n';
const LAUNCH = JSON.stringify({ profiles: { 'Shop.Api': { commandName: 'Project', applicationUrl: 'https://localhost:7181;http://localhost:5181' } } });
const HOST_START = 'dotnet run --project src/Shop.Api/Shop.Api.csproj --urls http://localhost:${PORT:-5181}';

let dir: string;
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

/** A .NET API with a web project, its tests and its launch settings. */
function shopApi(): void {
  write('Shop.sln', '\n');
  write('src/Shop.Api/Shop.Api.csproj', WEB_PROJECT);
  write('src/Shop.Api/Properties/launchSettings.json', LAUNCH);
  write('Shop.Api.Tests/Shop.Api.Tests.csproj', TEST_PROJECT);
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-compose-learn-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a .NET web app's start on this computer", () => {
  it('is its web project, never the tests, on the port its launch settings give and squad-kit can move', () => {
    shopApi();
    expect(findCommands(dir)).toEqual({ test: 'dotnet test', build: 'dotnet build', start: HOST_START, url: 'http://localhost:5181' });
    fs.rmSync(path.join(dir, 'src/Shop.Api/Properties'), { recursive: true });
    expect(findCommands(dir)).toMatchObject({ start: 'dotnet run --project src/Shop.Api/Shop.Api.csproj --urls http://localhost:${PORT:-5000}', url: 'http://localhost:5000' });
  });

  it('has none without a web project', () => {
    write('Shop.sln', '\n');
    write('src/Shop.Core/Shop.Core.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
    expect(findCommands(dir)).toEqual({ build: 'dotnet build' });
  });
});

describe('the env file Compose gives the app', () => {
  it("is learned from env_file on the service that builds the part's code, when it starts on this computer", () => {
    shopApi();
    write('docker-compose.yml', DAILY);
    expect(envFileToLearn(dir, { start: HOST_START })).toEqual({ envFile: '.env.dev', from: 'docker-compose.yml gives the api service its settings from it' });
    // findCommands finds the start for this computer, so it says the env file too.
    expect(findCommands(dir)).toMatchObject({ start: HOST_START, envFile: '.env.dev' });
  });

  it('reads every form of env_file, from a compose file one folder down, and leaves out examples and other places', () => {
    write(
      'docker/docker-compose.yml',
      `services:
  worker:
    build: ../src/Shop.Worker
    env_file: ../worker.env
  api:
    build: ../src/Shop.Api
    env_file:
      - path: ../.env.dev
        required: false
      - ../.env.example
      - ../.env.production
      - ../config/api.env
  cache:
    image: redis:7
    env_file: ../cache.env
`,
    );
    expect(envFileToLearn(dir, { start: HOST_START })).toEqual({ envFile: '.env.dev, config/api.env', from: 'docker/docker-compose.yml gives the api service its settings from it' });
    expect(envFileToLearn(dir, { start: 'npm start' })?.envFile).toBe('worker.env');
  });

  it('is learned from --env-file in a compose command of the README or the Makefile', () => {
    expect(envFileFlags('Run it:\n\n    docker compose --env-file .env.dev up -d\n    docker-compose --env-file=./config/dev.env --env-file "local.env" up\n    node --env-file .env app.js\n    docker compose --env-file ../outside.env up\n')).toEqual(['.env.dev', 'config/dev.env', 'local.env']);
    write('README.md', '# Booking\n\n```\ndocker compose --env-file .env.dev up\n```\n');
    expect(envFileToLearn(dir, { start: 'npm run dev' })).toEqual({ envFile: '.env.dev', from: 'a compose command in README.md reads it with --env-file' });
    fs.rmSync(path.join(dir, 'README.md'));
    write('Makefile', 'up:\n\tdocker compose --env-file .env.local up\n');
    expect(envFileToLearn(dir, { start: 'npm run dev' })?.envFile).toBe('.env.local');
  });

  it('is not learned for a part that starts in Compose, has no start, or has an env file already', () => {
    write('docker-compose.yml', DAILY);
    expect(envFileToLearn(dir, { start: 'docker compose up' })).toBeNull();
    expect(envFileToLearn(dir, { start: 'COMPOSE_PROJECT_NAME=shop docker compose up' })).toBeNull();
    expect(envFileToLearn(dir, { test: 'dotnet test' })).toBeNull();
    expect(envFileToLearn(dir, { start: HOST_START, envFile: 'mine.env' })).toBeNull();
  });
});

describe('a compose start that keeps the daily stack names', () => {
  it('is seen in fixed container names, and in a project name in the command or the file', () => {
    write('docker-compose.yml', DAILY);
    expect(composeStartRisk(dir, 'docker compose up --build')).toBe('fixed container names (shop-api, shop-mongo)');
    write('compose.only-name.yml', 'name: booking\nservices:\n  web:\n    build: .\n');
    expect(composeStartRisk(dir, 'docker compose -f compose.only-name.yml up')).toBe('the project name booking');
    write('compose.plain.yml', 'services:\n  web:\n    build: .\n');
    expect(composeStartRisk(dir, 'docker compose -f compose.plain.yml -p booking up')).toBe('the project name booking');
    expect(composeStartRisk(dir, 'COMPOSE_PROJECT_NAME=booking docker compose --file=compose.plain.yml up')).toBe('the project name booking');
    // squad-kit's own project name keeps a plain one apart from the daily stack (compose-run.ts).
    expect(composeStartRisk(dir, 'docker compose -f compose.plain.yml up')).toBeNull();
    expect(composeStartRisk(dir, 'dotnet run')).toBeNull();
  });

  it('is never saved as the start: the start for this computer takes its place, with the env file', () => {
    shopApi();
    write('docker-compose.yml', DAILY);
    const commands = { test: 'dotnet test', start: 'docker compose up --build', url: 'http://localhost:8080' };
    const changed = learnFromCompose(dir, commands, findCommands(dir), (program) => program === 'dotnet');
    expect(commands).toEqual({ test: 'dotnet test', start: HOST_START, url: 'http://localhost:5181', envFile: '.env.dev' });
    expect(changed).toEqual([
      `The read's start command (docker compose up --build) runs Docker Compose with fixed container names (shop-api, shop-mongo), which your own Docker stack uses too, so squad-kit never saves it as the start: it starts the app on this computer instead, with ${HOST_START}.`,
      'The app starts on this computer, and docker-compose.yml gives the api service its settings from it, so squad-kit gives the app the settings in .env.dev, with its own database, Redis and port on top.',
    ]);
  });

  it('is left out when the tools for the start here are missing, and nothing is learned for a start there is not', () => {
    shopApi();
    write('docker-compose.yml', DAILY);
    const commands = { test: 'dotnet test', start: 'docker compose up', url: 'http://localhost:8080' };
    const changed = learnFromCompose(dir, commands, findCommands(dir), () => false);
    expect(commands).toEqual({ test: 'dotnet test' });
    expect(changed).toEqual([`The read's start command (docker compose up) runs Docker Compose with fixed container names (shop-api, shop-mongo), which your own Docker stack uses too, so squad-kit never saves it as the start. Its start for this computer needs dotnet, which is not on this computer: ${HOST_START}. An engineer can set one in Settings.`]);
  });

  it("is never saved by the first read: the read's commands are made safe the same way", () => {
    shopApi();
    write('docker-compose.yml', DAILY);
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-compose-learn-bin-'));
    fs.writeFileSync(path.join(bin, 'dotnet'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const before = process.env.PATH;
    try {
      process.env.PATH = bin;
      const safe = fromTheRead(dir, { test: 'dotnet test', build: 'dotnet build', start: 'docker compose up -d', url: 'http://localhost:8080' });
      expect(safe.commands).toEqual({ test: 'dotnet test', build: 'dotnet build', start: HOST_START, url: 'http://localhost:5181', envFile: '.env.dev' });
      expect(safe.changed).toHaveLength(2);
      process.env.PATH = path.join(bin, 'nothing-here');
      expect(fromTheRead(dir, { test: 'dotnet test', start: 'docker compose up -d' }).commands).toEqual({ test: 'dotnet test' });
    } finally {
      process.env.PATH = before;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('a compose start with no fixed names stays, and gets no env file: Compose reads it itself', () => {
    write('compose.yaml', 'services:\n  web:\n    build: .\n    env_file: .env.dev\n');
    const safe = fromTheRead(dir, { start: 'docker compose up', url: 'http://localhost:3000' });
    expect(safe.commands).toEqual({ start: 'docker compose up', url: 'http://localhost:3000' });
    expect(safe.changed).toEqual([]);
  });
});
