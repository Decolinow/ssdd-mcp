import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createTeamCapacityConfiguration, getTeamCapacity, getTeamCapacityConfiguration, setTeamCapacityConfiguration } from "../../src/application/team-capacity.js";
import { listProjectTeams } from "../../src/application/team-directory.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";

describe("team calendar and capacity", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-capacity-"));
    const initialized = initializeProject({
      workspace,
      key: "PAY",
      name: "Payments",
      productGoal: "Pagamentos confiáveis",
      timezone: "America/Sao_Paulo",
    });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string }).created_by_principal_id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("calculates 84 hours for partial dedication and one full-day absence", () => {
    const developerId = addProjectMember("developer");
    const configured = configure({
      expectedVersion: 0,
      members: [
        { principalId, dedicationPercent: 100 },
        { principalId: developerId, dedicationPercent: 50 },
      ],
      absences: [{ principalId, date: "2026-11-10", hours: 6, reason: "Ausência de um dia" }],
    }).value;
    const capacity = getTeamCapacity(database, {
      projectId, principalId, startDate: "2026-11-09", endDate: "2026-11-20",
    });

    assert.equal(configured.version, 1);
    assert.equal(configured.generationNumber, 1);
    assert.equal(capacity.workdays, 10);
    assert.equal(capacity.generationNumber, 1);
    assert.equal(capacity.totalHours, 84);
    const developer = capacity.members.find((member) => member.principalId === developerId);
    const owner = capacity.members.find((member) => member.principalId === principalId);
    assert.deepEqual(developer && {
      availableHours: developer.availableHours,
      capacityLostToAbsenceHours: developer.capacityLostToAbsenceHours,
    }, { availableHours: 30, capacityLostToAbsenceHours: 0 });
    assert.deepEqual(owner && {
      availableHours: owner.availableHours,
      capacityLostToAbsenceHours: owner.capacityLostToAbsenceHours,
    }, { availableHours: 54, capacityLostToAbsenceHours: 6 });
    assert.equal(capacity.daily.find((day) => day.date === "2026-11-10")?.totalHours, 3);
  });

  it("keeps configuration and capacity isolated by explicit team and rejects ambiguity", () => {
    const primaryTeam = configure({
      expectedVersion: 0,
      teamName: "Payments",
      hoursPerDay: 6,
      members: [{ principalId, dedicationPercent: 100 }],
    }).value;
    const secondaryTeam = createTeamCapacityConfiguration(database, {
      projectId,
      principalId,
      requestId: `team-create-${randomUUID()}`,
      teamName: "Reconciliation",
      timezone: "America/Sao_Paulo",
      hoursPerDay: 8,
      workingDays: [1, 2, 3, 4, 5],
      members: [{ principalId, dedicationPercent: 50 }],
      reason: "Time dedicado à conciliação.",
    }).value;

    assert.notEqual(primaryTeam.teamId, secondaryTeam.teamId);
    assert.deepEqual(listProjectTeams(database, projectId, principalId).map((team) => [team.name, team.currentVersion, team.memberCount]), [
      ["Payments", 1, 1], ["Reconciliation", 1, 1],
    ]);
    assert.equal(getTeamCapacityConfiguration(database, projectId, principalId, undefined, primaryTeam.teamId).teamName, "Payments");
    assert.equal(getTeamCapacityConfiguration(database, projectId, principalId, undefined, secondaryTeam.teamId).teamName, "Reconciliation");
    assert.equal(getTeamCapacity(database, {
      projectId, principalId, teamId: primaryTeam.teamId, startDate: "2026-11-09", endDate: "2026-11-09",
    }).totalHours, 6);
    assert.equal(getTeamCapacity(database, {
      projectId, principalId, teamId: secondaryTeam.teamId, startDate: "2026-11-09", endDate: "2026-11-09",
    }).totalHours, 4);

    assert.throws(
      () => getTeamCapacity(database, { projectId, principalId, startDate: "2026-11-09", endDate: "2026-11-09" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED" &&
        Array.isArray((error.details as { teamOptions?: unknown[] }).teamOptions) &&
        (error.details as { teamOptions: unknown[] }).teamOptions.length === 2,
    );
  });

  it("reuses the migrated version-zero team and makes the first configuration retry-safe", () => {
    const teamId = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO teams (team_id, project_id, current_version, current_generation, created_at)
       VALUES (?, ?, 0, 0, ?)`,
    ).run(teamId, projectId, createdAt);

    assert.throws(() => database.prepare(
      `INSERT INTO team_config_versions
        (project_id, team_id, version, generation_number, team_name, timezone, hours_per_day, working_days_json,
         reason, created_by_principal_id, created_at)
       VALUES (?, ?, 1, 1, 'Invalid early config', 'UTC', 8, '[1,2,3,4,5]', 'Before head update', ?, ?)`,
    ).run(projectId, teamId, principalId, createdAt), /must match the current team version/);

    assert.throws(
      () => getTeamCapacityConfiguration(database, projectId, principalId),
      (error: unknown) => error instanceof ApplicationError && error.code === "NOT_FOUND",
    );

    const input = {
      projectId,
      principalId,
      requestId: `team-config-initial-${randomUUID()}`,
      expectedVersion: 0,
      teamName: "Payments team",
      timezone: "America/Sao_Paulo",
      hoursPerDay: 6,
      workingDays: [1, 2, 3, 4, 5],
      members: [{ principalId, dedicationPercent: 100 }],
      reason: "Initial team capacity configuration.",
    } as const;
    const first = setTeamCapacityConfiguration(database, input);
    const retry = setTeamCapacityConfiguration(database, input);

    assert.deepEqual(retry, first);
    assert.equal(first.value.teamId, teamId);
    assert.equal(first.value.version, 1);
    assert.equal(first.value.generationNumber, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM teams WHERE project_id = ?")
      .get(projectId) as { count: number }).count, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM team_config_versions WHERE project_id = ?")
      .get(projectId) as { count: number }).count, 1);
    assert.equal((database.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE project_id = ? AND event_type = 'team.capacity_configured'",
    ).get(projectId) as { count: number }).count, 1);
    assert.throws(
      () => database.prepare("UPDATE teams SET current_version = 0 WHERE project_id = ? AND team_id = ?")
        .run(projectId, teamId),
      /cannot return to version zero/,
    );
  });

  it("versions team capacity and calendars, reads prior snapshots and rejects stale updates", () => {
    const developerId = addProjectMember("developer");
    configure({
      expectedVersion: 0,
      members: [
        { principalId, dedicationPercent: 100 },
        { principalId: developerId, dedicationPercent: 50 },
      ],
      absences: [{ principalId, date: "2026-11-10", hours: 6, reason: "Ausência de um dia" }],
    });
    const revised = configure({
      expectedVersion: 1,
      members: [
        { principalId, dedicationPercent: 100 },
        { principalId: developerId, dedicationPercent: 50 },
      ],
      holidays: [{ date: "2026-11-09", label: "Feriado local" }],
      absences: [{ principalId, date: "2026-11-10", hours: 6, reason: "Ausência de um dia" }],
    }).value;
    assert.equal(revised.version, 2);
    assert.equal(revised.generationNumber, 1);
    assert.equal(getTeamCapacityConfiguration(database, projectId, principalId, 1).version, 1);
    assert.equal(getTeamCapacityConfiguration(database, projectId, principalId, 1).generationNumber, 1);
    assert.equal(getTeamCapacity(database, {
      projectId, principalId, startDate: "2026-11-09", endDate: "2026-11-20", configVersion: 1,
    }).totalHours, 84);
    const revisedCapacity = getTeamCapacity(database, {
      projectId, principalId, startDate: "2026-11-09", endDate: "2026-11-20",
    });
    assert.equal(revisedCapacity.workdays, 9);
    assert.equal(revisedCapacity.totalHours, 75);
    assert.equal(revisedCapacity.generationNumber, 1);

    assert.throws(
      () => configure({
        expectedVersion: 1,
        members: [{ principalId, dedicationPercent: 100 }],
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT",
    );
    assert.throws(
      () => database.prepare("UPDATE team_config_versions SET team_name = 'mutated' WHERE version = 1").run(),
      /immutable/,
    );
    const membershipChanged = configure({
      expectedVersion: 2,
      members: [{ principalId, dedicationPercent: 100 }],
    }).value;
    assert.equal(membershipChanged.version, 3);
    assert.equal(membershipChanged.generationNumber, 2);
    assert.equal(getTeamCapacityConfiguration(database, projectId, principalId, 2).generationNumber, 1);
    assert.equal(getTeamCapacity(database, {
      projectId, principalId, startDate: "2026-11-09", endDate: "2026-11-20",
    }).generationNumber, 2);
  });

  it("rejects non-member capacity entries and invalid calendar dates without partial writes", () => {
    const nonMemberId = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
       VALUES (?, 'human', ?, 'Outsider', ?)`,
    ).run(nonMemberId, `outsider:${nonMemberId}`, createdAt);
    assert.throws(
      () => configure({ expectedVersion: 0, members: [{ principalId: nonMemberId, dedicationPercent: 100 }] }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM teams WHERE project_id = ?")
      .get(projectId) as { count: number }).count, 0);

    assert.throws(
      () => getTeamCapacity(database, { projectId, principalId, startDate: "2026-02-30", endDate: "2026-03-01" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
  });

  function addProjectMember(role: "developer" | "qa"): string {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
       VALUES (?, 'human', ?, ?, ?)`,
    ).run(id, `capacity:${id}`, `Capacity ${role}`, createdAt);
    database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)",
    ).run(projectId, id, role, createdAt);
    return id;
  }

  function configure(input: {
    expectedVersion: number;
    teamName?: string;
    hoursPerDay?: number;
    members: readonly { principalId: string; dedicationPercent: number }[];
    holidays?: readonly { date: string; label: string }[];
    absences?: readonly { principalId: string; date: string; hours: number; reason: string }[];
  }) {
    return setTeamCapacityConfiguration(database, {
      projectId,
      principalId,
      requestId: `team-config-${randomUUID()}`,
      teamName: "Payments team",
      timezone: "America/Sao_Paulo",
      hoursPerDay: 6,
      workingDays: [1, 2, 3, 4, 5],
      reason: "Atualização da disponibilidade da equipe.",
      ...input,
    });
  }
});
