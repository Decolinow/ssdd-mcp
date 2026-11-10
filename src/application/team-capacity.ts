import { randomUUID } from "node:crypto";
import type {
  TeamAbsence,
  TeamCapacityConfiguration,
  TeamCapacityDay,
  TeamCapacityMemberResult,
  TeamCapacityReport,
  TeamHoliday,
  TeamMemberCapacity,
} from "../domain/teams.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { resolveProjectTeamId } from "./team-directory.js";

export interface SetTeamCapacityInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly teamId?: string;
  readonly expectedVersion: number;
  readonly teamName: string;
  readonly timezone: string;
  readonly hoursPerDay: number;
  readonly workingDays: readonly number[];
  readonly members: readonly {
    readonly principalId: string;
    readonly dedicationPercent: number;
    readonly activeFrom?: string | undefined;
    readonly activeUntil?: string | undefined;
  }[];
  readonly holidays?: readonly { readonly date: string; readonly label: string }[];
  readonly absences?: readonly {
    readonly principalId: string;
    readonly date: string;
    readonly hours: number;
    readonly reason: string;
  }[];
  readonly reason: string;
}

export interface GetTeamCapacityInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly configVersion?: number;
  readonly teamId?: string;
}

interface NormalizedTeamMember {
  readonly principalId: string;
  readonly dedicationPercent: number;
  readonly activeFrom: string | null;
  readonly activeUntil: string | null;
}

interface TeamConfigurationRow {
  readonly project_id: string;
  readonly team_id: string;
  readonly generation_number: number;
  readonly version: number;
  readonly team_name: string;
  readonly timezone: string;
  readonly hours_per_day: number;
  readonly working_days_json: string;
  readonly reason: string;
  readonly created_by_principal_id: string;
  readonly created_at: string;
}

export function setTeamCapacityConfiguration(
  database: SqliteDatabase,
  input: SetTeamCapacityInput,
): CommandReceipt<TeamCapacityConfiguration> {
  return configureTeamCapacity(database, input, false);
}

export type CreateTeamCapacityInput = Omit<SetTeamCapacityInput, "expectedVersion" | "teamId">;

export function createTeamCapacityConfiguration(
  database: SqliteDatabase,
  input: CreateTeamCapacityInput,
): CommandReceipt<TeamCapacityConfiguration> {
  return configureTeamCapacity(database, { ...input, expectedVersion: 0 }, true);
}

function configureTeamCapacity(
  database: SqliteDatabase,
  input: SetTeamCapacityInput,
  createNewTeam: boolean,
): CommandReceipt<TeamCapacityConfiguration> {
  const configuration = normalizeConfiguration(input);
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: createNewTeam ? "team.create" : "team.capacity.configure",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      teamId: input.teamId ?? null,
      expectedVersion: input.expectedVersion,
      teamName: configuration.teamName,
      timezone: configuration.timezone,
      hoursPerDay: configuration.hoursPerDay,
      workingDays: [...configuration.workingDays],
      members: configuration.members.map((member) => ({
        principalId: member.principalId,
        dedicationPercent: member.dedicationPercent,
        activeFrom: member.activeFrom,
        activeUntil: member.activeUntil,
      })),
      holidays: configuration.holidays.map((holiday) => ({ date: holiday.date, label: holiday.label })),
      absences: configuration.absences.map((absence) => ({
        principalId: absence.principalId,
        date: absence.date,
        hours: absence.hours,
        reason: absence.reason,
      })),
      reason: configuration.reason,
    },
    requiredRoles: ["po", "facilitator"],
    auditEvent: (result) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: createNewTeam ? "team.created" : "team.capacity_configured",
      entityType: "team",
      entityId: result.teamId,
      reason: result.reason,
      payload: {
        version: result.version,
        memberCount: result.members.length,
        holidayCount: result.holidays.length,
        absenceCount: result.absences.length,
      },
    }),
    execute: () => {
      assertHuman(database, input.principalId, "Only a human PO or facilitator may configure team capacity.");
      for (const member of configuration.members) assertProjectHumanMember(database, input.projectId, member.principalId);

      const selectedTeamId = createNewTeam
        ? null
        : resolveProjectTeamId(database, input.projectId, input.teamId);
      const team = selectedTeamId === null
        ? undefined
        : database.prepare(
          "SELECT team_id, current_version, current_generation FROM teams WHERE project_id = ? AND team_id = ?",
        ).get(input.projectId, selectedTeamId) as { team_id: string; current_version: number; current_generation: number } | undefined;
      if (!createNewTeam && input.teamId !== undefined && team === undefined) {
        throw new ApplicationError("NOT_FOUND", "Team was not found in this project.");
      }
      let teamId: string;
      let version: number;
      let currentGeneration: number;
      const now = new Date().toISOString();
      if (input.expectedVersion === 0) {
        if (createNewTeam) {
          teamId = randomUUID();
          version = 1;
          currentGeneration = 0;
          database.prepare(
            "INSERT INTO teams (team_id, project_id, current_version, current_generation, created_at) VALUES (?, ?, 0, 0, ?)",
          ).run(teamId, input.projectId, now);
        } else {
        if (team !== undefined && team.current_version !== 0) {
          throw new ApplicationError("VERSION_CONFLICT", "A team is already configured for this project.", {
            details: { expectedVersion: 0, actualVersion: team.current_version },
          });
        }
        teamId = team?.team_id ?? randomUUID();
        version = 1;
        currentGeneration = 0;
        if (team === undefined) {
          database.prepare(
            "INSERT INTO teams (team_id, project_id, current_version, current_generation, created_at) VALUES (?, ?, 0, 0, ?)",
          ).run(teamId, input.projectId, now);
        }
        }
      } else {
        if (team === undefined) throw new ApplicationError("NOT_FOUND", "Team capacity is not configured for this project.");
        if (team.current_version !== input.expectedVersion) {
          throw new ApplicationError("VERSION_CONFLICT", "Team capacity changed since it was read.", {
            details: { expectedVersion: input.expectedVersion, actualVersion: team.current_version },
          });
        }
        teamId = team.team_id;
        version = input.expectedVersion + 1;
        currentGeneration = team.current_generation;
      }

      const generationNumber = currentGeneration === 0
        ? 1
        : (sameMemberComposition(
          readMemberComposition(database, input.projectId, teamId, input.expectedVersion),
          configuration.members,
        ) ? currentGeneration : currentGeneration + 1);
      const updated = database.prepare(
        `UPDATE teams SET current_version = ?, current_generation = ?
         WHERE project_id = ? AND team_id = ? AND current_version = ? AND current_generation = ?`,
      ).run(
        version,
        generationNumber,
        input.projectId,
        teamId,
        input.expectedVersion,
        currentGeneration,
      );
      if (updated.changes !== 1) throw new ApplicationError("VERSION_CONFLICT", "Team capacity changed during configuration.");

      database.prepare(
        `INSERT INTO team_config_versions
          (project_id, team_id, version, generation_number, team_name, timezone, hours_per_day, working_days_json,
           reason, created_by_principal_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.projectId, teamId, version, generationNumber, configuration.teamName, configuration.timezone,
        configuration.hoursPerDay, JSON.stringify(configuration.workingDays), configuration.reason,
        input.principalId, now,
      );
      const insertMember = database.prepare(
        `INSERT INTO team_member_capacities
          (project_id, team_id, config_version, principal_id, dedication_percent, active_from, active_until)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const member of configuration.members) {
        insertMember.run(
          input.projectId, teamId, version, member.principalId, member.dedicationPercent,
          member.activeFrom, member.activeUntil,
        );
      }
      const insertHoliday = database.prepare(
        "INSERT INTO team_holidays (project_id, team_id, config_version, holiday_date, label) VALUES (?, ?, ?, ?, ?)",
      );
      for (const holiday of configuration.holidays) {
        insertHoliday.run(input.projectId, teamId, version, holiday.date, holiday.label);
      }
      const insertAbsence = database.prepare(
        `INSERT INTO team_absences
          (project_id, team_id, config_version, principal_id, absence_date, hours, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const absence of configuration.absences) {
        insertAbsence.run(
          input.projectId, teamId, version, absence.principalId, absence.date, absence.hours, absence.reason,
        );
      }
      return readConfiguration(database, input.projectId, teamId, version);
    },
  });
}

export function getTeamCapacityConfiguration(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  version?: number,
  teamId?: string,
): TeamCapacityConfiguration {
  assertProjectAuthorization(database, projectId, principalId);
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
    throw new ApplicationError("VALIDATION_FAILED", "Configuration version must be a positive integer.");
  }
  const resolvedTeamId = resolveProjectTeamId(database, projectId, teamId);
  if (resolvedTeamId === null) {
    throw new ApplicationError("NOT_FOUND", "Team capacity is not configured for this project.");
  }
  const team = database.prepare("SELECT current_version FROM teams WHERE project_id = ? AND team_id = ?")
    .get(projectId, resolvedTeamId) as { current_version: number } | undefined;
  if (team === undefined || team.current_version === 0) {
    throw new ApplicationError("NOT_FOUND", "Team capacity is not configured for this project.");
  }
  return readConfiguration(database, projectId, resolvedTeamId, version ?? team.current_version);
}

export function getTeamCapacity(
  database: SqliteDatabase,
  input: GetTeamCapacityInput,
): TeamCapacityReport {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const start = parseDate(input.startDate, "Start date");
  const end = parseDate(input.endDate, "End date");
  if (start.getTime() > end.getTime()) {
    throw new ApplicationError("VALIDATION_FAILED", "Start date must be on or before end date.");
  }
  if ((end.getTime() - start.getTime()) / 86_400_000 > 366) {
    throw new ApplicationError("VALIDATION_FAILED", "Capacity query range cannot exceed 367 calendar days.");
  }
  const configuration = getTeamCapacityConfiguration(
    database, input.projectId, input.principalId, input.configVersion, input.teamId,
  );
  const workDays = new Set(configuration.workingDays);
  const holidays = new Set(configuration.holidays.map((holiday) => holiday.date));
  const absenceByMemberAndDate = new Map(
    configuration.absences.map((absence) => [`${absence.principalId}\u0000${absence.date}`, absence.hours]),
  );
  const memberTotals = new Map(configuration.members.map((member) => [member.principalId, {
    activeWorkdays: 0,
    availableHours: 0,
    capacityLostToAbsenceHours: 0,
  }]));
  const daily: TeamCapacityDay[] = [];
  let workdayCount = 0;
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const date = cursor.toISOString().slice(0, 10);
    const dayNumber = cursor.getUTCDay() === 0 ? 7 : cursor.getUTCDay();
    const isWorkDay = workDays.has(dayNumber) && !holidays.has(date);
    if (isWorkDay) workdayCount += 1;
    let dayHours = 0;
    if (isWorkDay) {
      for (const member of configuration.members) {
        if ((member.activeFrom !== null && date < member.activeFrom) ||
            (member.activeUntil !== null && date > member.activeUntil)) continue;
        const totals = memberTotals.get(member.principalId);
        if (totals === undefined) continue;
        totals.activeWorkdays += 1;
        const scheduledHours = configuration.hoursPerDay;
        const absentHours = Math.min(
          scheduledHours,
          absenceByMemberAndDate.get(`${member.principalId}\u0000${date}`) ?? 0,
        );
        const lostCapacity = absentHours * (member.dedicationPercent / 100);
        const memberHours = (scheduledHours - absentHours) * (member.dedicationPercent / 100);
        totals.capacityLostToAbsenceHours += lostCapacity;
        totals.availableHours += memberHours;
        dayHours += memberHours;
      }
    }
    daily.push({ date, totalHours: roundHours(dayHours) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const members: TeamCapacityMemberResult[] = configuration.members.map((member) => {
    const totals = memberTotals.get(member.principalId)!;
    return {
      ...member,
      activeWorkdays: totals.activeWorkdays,
      availableHours: roundHours(totals.availableHours),
      capacityLostToAbsenceHours: roundHours(totals.capacityLostToAbsenceHours),
    };
  });
  return {
    projectId: configuration.projectId,
    teamId: configuration.teamId,
    generationNumber: configuration.generationNumber,
    teamName: configuration.teamName,
    version: configuration.version,
    timezone: configuration.timezone,
    startDate: input.startDate,
    endDate: input.endDate,
    workdays: workdayCount,
    totalHours: roundHours(members.reduce((total, member) => total + member.availableHours, 0)),
    members,
    daily,
  };
}

function normalizeConfiguration(input: SetTeamCapacityInput): {
  readonly teamName: string;
  readonly timezone: string;
  readonly hoursPerDay: number;
  readonly workingDays: readonly number[];
  readonly members: readonly NormalizedTeamMember[];
  readonly holidays: readonly TeamHoliday[];
  readonly absences: readonly TeamAbsence[];
  readonly reason: string;
} {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new ApplicationError("VALIDATION_FAILED", "Expected version must be a non-negative integer (0 creates the team).");
  }
  const teamName = normalizeText(input.teamName, 120, "Team name must contain 1-120 characters.");
  const timezone = normalizeText(input.timezone, 100, "Timezone must contain 1-100 characters.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new ApplicationError("VALIDATION_FAILED", "Timezone must be a valid IANA timezone.");
  }
  if (!Number.isFinite(input.hoursPerDay) || input.hoursPerDay <= 0 || input.hoursPerDay > 24) {
    throw new ApplicationError("VALIDATION_FAILED", "Hours per day must be greater than 0 and no more than 24.");
  }
  const hoursPerDay = roundHours(input.hoursPerDay);
  if (hoursPerDay <= 0) throw new ApplicationError("VALIDATION_FAILED", "Hours per day must be at least 0.01.");
  const workingDays = [...new Set(input.workingDays)].sort((left, right) => left - right);
  if (workingDays.length === 0 || workingDays.some((day) => !Number.isSafeInteger(day) || day < 1 || day > 7)) {
    throw new ApplicationError("VALIDATION_FAILED", "Working days must contain unique ISO weekday numbers from 1 to 7.");
  }
  if (input.members.length < 1 || input.members.length > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "A team configuration must contain 1-100 members.");
  }
  const memberIds = new Set<string>();
  const members = input.members.map((member): NormalizedTeamMember => {
    const principalId = normalizeText(member.principalId, 80, "Team member principal ID is required.");
    if (memberIds.has(principalId)) throw new ApplicationError("VALIDATION_FAILED", "A team member can appear only once.");
    memberIds.add(principalId);
    if (!Number.isFinite(member.dedicationPercent) || member.dedicationPercent < 0 || member.dedicationPercent > 100) {
      throw new ApplicationError("VALIDATION_FAILED", "Member dedication must be between 0 and 100 percent.");
    }
    const activeFrom = member.activeFrom === undefined ? null : normalizeDate(member.activeFrom, "Member start date");
    const activeUntil = member.activeUntil === undefined ? null : normalizeDate(member.activeUntil, "Member end date");
    if (activeFrom !== null && activeUntil !== null && activeFrom > activeUntil) {
      throw new ApplicationError("VALIDATION_FAILED", "Member start date must be on or before the end date.");
    }
    return { principalId, dedicationPercent: roundHours(member.dedicationPercent), activeFrom, activeUntil };
  }).sort((left, right) => left.principalId.localeCompare(right.principalId));
  const holidays = [...(input.holidays ?? [])].map((holiday): TeamHoliday => ({
    date: normalizeDate(holiday.date, "Holiday date"),
    label: normalizeText(holiday.label, 200, "Holiday label must contain 1-200 characters."),
  })).sort((left, right) => left.date.localeCompare(right.date));
  if (holidays.length > 500 || new Set(holidays.map((holiday) => holiday.date)).size !== holidays.length) {
    throw new ApplicationError("VALIDATION_FAILED", "Provide at most 500 unique holiday dates.");
  }
  const absences = [...(input.absences ?? [])].map((absence): TeamAbsence => {
    const principalId = normalizeText(absence.principalId, 80, "Absence principal ID is required.");
    if (!memberIds.has(principalId)) {
      throw new ApplicationError("VALIDATION_FAILED", "An absence must refer to a member in this team configuration.");
    }
    if (!Number.isFinite(absence.hours) || absence.hours < 0 || absence.hours > 24) {
      throw new ApplicationError("VALIDATION_FAILED", "Absence hours must be between 0 and 24.");
    }
    return {
      principalId,
      date: normalizeDate(absence.date, "Absence date"),
      hours: roundHours(absence.hours),
      reason: normalizeText(absence.reason, 200, "Absence reason must contain 1-200 characters."),
    };
  }).sort((left, right) => left.principalId.localeCompare(right.principalId) || left.date.localeCompare(right.date));
  if (absences.length > 5_000 || new Set(absences.map((absence) => `${absence.principalId}\u0000${absence.date}`)).size !== absences.length) {
    throw new ApplicationError("VALIDATION_FAILED", "Provide at most 5000 unique member absence dates.");
  }
  return {
    teamName,
    timezone,
    hoursPerDay,
    workingDays,
    members,
    holidays,
    absences,
    reason: normalizeText(input.reason, 1_000, "Configuration reason must contain 1-1000 characters."),
  };
}

function readConfiguration(
  database: SqliteDatabase,
  projectId: string,
  teamId: string,
  version: number,
): TeamCapacityConfiguration {
  const row = database.prepare(
    `SELECT project_id, team_id, version, generation_number, team_name, timezone, hours_per_day, working_days_json,
            reason, created_by_principal_id, created_at
     FROM team_config_versions WHERE project_id = ? AND team_id = ? AND version = ?`,
  ).get(projectId, teamId, version) as TeamConfigurationRow | undefined;
  if (row === undefined) throw new ApplicationError("NOT_FOUND", "Team configuration version was not found.");
  const members = database.prepare(
    `SELECT mc.principal_id, p.display_name, mc.dedication_percent, mc.active_from, mc.active_until
     FROM team_member_capacities mc INNER JOIN principals p ON p.principal_id = mc.principal_id
     WHERE mc.project_id = ? AND mc.team_id = ? AND mc.config_version = ?
     ORDER BY p.display_name COLLATE NOCASE, mc.principal_id`,
  ).all(projectId, teamId, version) as Array<{
    principal_id: string;
    display_name: string;
    dedication_percent: number;
    active_from: string | null;
    active_until: string | null;
  }>;
  const holidays = database.prepare(
    `SELECT holiday_date, label FROM team_holidays
     WHERE project_id = ? AND team_id = ? AND config_version = ? ORDER BY holiday_date`,
  ).all(projectId, teamId, version) as Array<{ holiday_date: string; label: string }>;
  const absences = database.prepare(
    `SELECT principal_id, absence_date, hours, reason FROM team_absences
     WHERE project_id = ? AND team_id = ? AND config_version = ? ORDER BY absence_date, principal_id`,
  ).all(projectId, teamId, version) as Array<{
    principal_id: string; absence_date: string; hours: number; reason: string;
  }>;
  return {
    projectId: row.project_id,
    teamId: row.team_id,
    generationNumber: row.generation_number,
    version: row.version,
    teamName: row.team_name,
    timezone: row.timezone,
    hoursPerDay: row.hours_per_day,
    workingDays: JSON.parse(row.working_days_json) as number[],
    members: members.map((member): TeamMemberCapacity => ({
      principalId: member.principal_id,
      displayName: member.display_name,
      dedicationPercent: member.dedication_percent,
      activeFrom: member.active_from,
      activeUntil: member.active_until,
    })),
    holidays: holidays.map((holiday): TeamHoliday => ({ date: holiday.holiday_date, label: holiday.label })),
    absences: absences.map((absence): TeamAbsence => ({
      principalId: absence.principal_id,
      date: absence.absence_date,
      hours: absence.hours,
      reason: absence.reason,
    })),
    reason: row.reason,
    configuredByPrincipalId: row.created_by_principal_id,
    configuredAt: row.created_at,
  };
}

function readMemberComposition(
  database: SqliteDatabase,
  projectId: string,
  teamId: string,
  version: number,
): readonly NormalizedTeamMember[] {
  const rows = database.prepare(
    `SELECT principal_id, dedication_percent, active_from, active_until
     FROM team_member_capacities WHERE project_id = ? AND team_id = ? AND config_version = ?
     ORDER BY principal_id`,
  ).all(projectId, teamId, version) as Array<{
    principal_id: string;
    dedication_percent: number;
    active_from: string | null;
    active_until: string | null;
  }>;
  return rows.map((row) => ({
    principalId: row.principal_id,
    dedicationPercent: row.dedication_percent,
    activeFrom: row.active_from,
    activeUntil: row.active_until,
  }));
}

function sameMemberComposition(
  current: readonly NormalizedTeamMember[],
  proposed: readonly NormalizedTeamMember[],
): boolean {
  return JSON.stringify(current) === JSON.stringify(proposed);
}

function assertProjectHumanMember(database: SqliteDatabase, projectId: string, principalId: string): void {
  const row = database.prepare(
    `SELECT p.principal_type FROM principals p INNER JOIN project_memberships pm
       ON pm.principal_id = p.principal_id
     WHERE pm.project_id = ? AND p.principal_id = ? LIMIT 1`,
  ).get(projectId, principalId) as { principal_type: string } | undefined;
  if (row?.principal_type !== "human") {
    throw new ApplicationError("VALIDATION_FAILED", "Team capacity can be assigned only to human project members.", {
      details: { principalId },
    });
  }
}

function assertHuman(database: SqliteDatabase, principalId: string, message: string): void {
  const row = database.prepare("SELECT principal_type FROM principals WHERE principal_id = ?")
    .get(principalId) as { principal_type: string } | undefined;
  if (row?.principal_type !== "human") throw new ApplicationError("FORBIDDEN", message);
}

function normalizeDate(value: string, label: string): string {
  const date = parseDate(value, label);
  return date.toISOString().slice(0, 10);
}

function parseDate(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", `${label} must use YYYY-MM-DD format.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ApplicationError("VALIDATION_FAILED", `${label} must be a valid calendar date.`);
  }
  return date;
}

function normalizeText(value: string, maxLength: number, message: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) throw new ApplicationError("VALIDATION_FAILED", message);
  return normalized;
}

function roundHours(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
