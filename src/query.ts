import chalk from 'chalk';
import * as semver from 'semver';
import debug from 'debug';
import path from 'node:path';
import {
    parse,
    type AND_Expr,
    type EQ_Expr,
    type LIKE_Expr,
    type OR_Expr,
    type SQLColumns,
    type SEMVER_Expr,
} from 'node-query';
import {readCSV} from './csv';

const logger = debug('csvql:query');

export async function executeQuery(sql: string, cwd: string): Promise<{ source: string, total: number, page: number, pages: number, header: string[], result: string[][] }> {
    const query = parse(sql);

    if (query.type !== 'select') {
        console.error(chalk.red(`Query type (${chalk.green(query.type)}) not supported.`));
        process.exit(1);
    }

    logger('Query %O', query);

    const {table} = query.from[0];
    const [{value: offset = 0}, {value: limit = 10}] = query.limit;
    const start = offset * limit;
    const end = start + limit;
    const page = offset + 1;
    const filePath = path.join(cwd, `${table}.csv`);

    let operation: Operation;
    let left: { column: string } | undefined;
    let right: { value: any } | undefined;

    if (query.where.operator !== undefined) {
        left = query.where.left;
        right = query.where.right;
        operation = getOperation(query.where.operator);
    } else if (query.where.type === 'function') {
        left = query.where.args.value[0];
        right = query.where.args.value[1];
        operation = getOperation(query.where.name);
    } else {
        operation = getOperation('none');
    }

    let line = 0;
    let total = 0;
    let result: string[][] = [];
    let shouldSetupHeader = true;
    let header: string[] = [];
    let originalHeader: string[] = [];
    let headerIndex: Record<string, number> = {};
    let headerName: Record<string, string> = {};

    for await (const row of readCSV(filePath)) {
        line++;

        if (shouldSetupHeader) {
            originalHeader = header = row;

            if (Array.isArray(query.columns)) {
                header = query.columns.map(getColumnName);
                headerIndex = query.columns.reduce((value, column, index) => ({
                    ...value,
                    [getColumnName(column)]: index
                }), {});
                headerName = query.columns.reduce((value, column) => ({
                    ...value,
                    [getColumnName(column)]: column.as || getColumnName(column)
                }), {});
            } else {
                headerIndex = header.reduce((value, column, index) => ({
                    ...value,
                    [column]: index
                }), {});
                headerName = header.reduce((value, column) => ({
                    ...value,
                    [column]: column
                }), {});
            }

            shouldSetupHeader = false;

            continue;
        }

        if (originalHeader.length !== row.length) {
            throw new Error(`The number of header columns are different to row columns (line: ${line})`);
        }

        const data = operation(row, originalHeader, left, right);

        if (data !== undefined) {
            if (result.length === limit || (start !== 0 && total < start) || total > end) {
                total++;
                continue;
            }

            total++;
            result.push(data);
        }
    }

    result = result.map((row) => row
        .reduce<string[]>((value, column, index) => {
            const position = headerIndex[originalHeader[index]];

            if (position !== undefined) {
                value[position] = column;
            }

            return value;
        }, [])
    );

    let pages = total / limit;
    pages = Number.isInteger(pages) ? pages : (pages | 0) + 1;

    return {
        source: filePath,
        total,
        page,
        pages: Math.max(1, pages),
        header: header.map((name) => headerName[name]),
        result
    };
}

function getColumnName(column: SQLColumns[number]): string {
    // @ts-ignore
    if (column.expr.name !== undefined) {
        // @ts-ignore
        return `${column.expr.name}(${column.expr.args.expr.value})`;
    }

    // @ts-ignore
    return column.expr.column;
}

const SQLOperations = {
    'none': executeNoneOperation,
    '=': executeEqualOperation,
    'LIKE': executeLikeOperation,
    'AND': executeAndOperation,
    'OR': executeOrOperation,
    'SEMVER': executeSemverOperation,
};

type Operation = (data: string[], header: string[], left: any, right: any) => string[] | undefined;

function getOperation(operator: keyof typeof SQLOperations) {
    const operation = SQLOperations[operator];

    if (operation === undefined) {
        console.error(chalk.red(`Operation (${chalk.green(operator)}) not supported.`));
        process.exit(1);
    }

    return operation;
}


function executeNoneOperation(data: string[], header: string[]): string[] | undefined {
    return data;
}

function executeSemverOperation(data: string[], header: string[], left: SEMVER_Expr['args']['value']['0'], right: SEMVER_Expr['args']['value']['1']): string[] | undefined {
    const {column: columnName} = left;
    const {value} = right;
    const column = header.findIndex((value) => value === columnName);


    if (semver.valid(data[column]) === null) {
        return;
    }

    if (
        (typeof value === 'string' && semver.validRange(value) === null)
        || (typeof value === 'number' && semver.coerce(value) === null)
    ) {
        throw new Error(chalk.red(`Invalid version or range: ${value}`));
    }

    if (semver.satisfies(data[column], String(value))) {
        return data;
    }
}

function executeEqualOperation(data: string[], header: string[], left: EQ_Expr['left'], right: EQ_Expr['right']): string[] | undefined {
    const {column: columnName} = left;
    const {value} = right;
    const column = header.findIndex((value) => value === columnName);
    const transformedValue =
        typeof value === 'number' ? parseInt(data[column], 10)
            : typeof value === 'boolean' ? data[column] === 'true'
                : data[column];

    if (transformedValue !== value) {
        return;
    }

    return data;
}

function executeAndOperation(data: string[], header: string[], left: AND_Expr['left'], right: AND_Expr['right']): string[] | undefined {
    const result = getOperation(left.operator)(data, header, left.left, left.right);

    if (result === undefined) {
        return undefined;
    }

    return getOperation(right.operator)(result, header, right.left, right.right);
}

function executeOrOperation(data: string[], header: string[], left: OR_Expr['left'], right: OR_Expr['right']): string[] | undefined {
    const resultA = getOperation(left.operator)(data, header, left.left, left.right);

    if (resultA !== undefined) {
        return resultA;
    }

    return getOperation(right.operator)(data, header, right.left, right.right);
}

function executeLikeOperation(data: string[], header: string[], left: LIKE_Expr['left'], right: LIKE_Expr['right']): string[] | undefined {
    const {column: columnName} = left;
    const {value} = right;

    const column = header.findIndex((value) => value === columnName);
    const anyBegin = value.startsWith('%');
    const anyEnd = value.endsWith('%');
    const middleWith = anyBegin && anyEnd;
    const search = value
        .replace(/%/g, '')
        .replace(/\./g, '\\.');

    let reg: RegExp | undefined;

    if (middleWith) {
        reg = new RegExp(`^.*(${search}).*$`);
    } else if (anyBegin) {
        reg = new RegExp(`^.*(${search})$`);
    } else if (anyEnd) {
        reg = new RegExp(`^(${search}).*$`);
    }

    if (reg?.test(data[column]) === true) {
        return data;
    }
}
