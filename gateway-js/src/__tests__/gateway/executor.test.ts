import { fetch } from '../../__mocks__/make-fetch-happen-fetcher';
import gql from 'graphql-tag';
import { ApolloGateway } from '../../';
import { fixtures } from 'apollo-federation-integration-testsuite';
import type { Logger } from '@apollo/utils.logger';

let logger: {
  warn: jest.MockedFunction<Logger['warn']>,
  debug: jest.MockedFunction<Logger['debug']>,
  error: jest.MockedFunction<Logger['error']>,
  info: jest.MockedFunction<Logger['info']>,
}

beforeEach(() => {
  fetch.mockReset();

  logger = {
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  };
});

describe('ApolloGateway executor', () => {
  it('validates requests prior to execution', async () => {
    const gateway = new ApolloGateway({
      localServiceList: fixtures,
    });

    const { executor } = await gateway.load();

    const source = `#graphql
      query InvalidVariables($first: Int!) {
        topReviews(first: $first) {
          body
        }
      }
    `;

     // eslint-disable-next-line @typescript-eslint/ban-ts-comment
     // @ts-ignore
    const { errors } = await executor({
      source,
      document: gql(source),
      request: {
        variables: { first: '3' },
      },
      queryHash: 'hashed',
      context: null,
      cache: {} as any,
      logger,
    });

    expect(errors![0].message).toMatch(
      'Variable "$first" got invalid value "3";',
    );
  });

  it('should not crash if variables are not provided', async () => {
    const me = { birthDate: '1988-10-21'};
    fetch.mockJSONResponseOnce({ data: { me } });
    const gateway = new ApolloGateway({
      localServiceList: fixtures,
    });

    const { executor } = await gateway.load();

    const source = `#graphql
      query Me($locale: String) {
        me {
          birthDate(locale: $locale)
        }
      }
    `;

     // eslint-disable-next-line @typescript-eslint/ban-ts-comment
     // @ts-ignore
    const { errors, data } = await executor({
      source,
      document: gql(source),
      request: {
      },
      queryHash: 'hashed',
      context: null,
      cache: {} as any,
      logger,
    });

    expect(errors).toBeFalsy();
    expect(data).toEqual({ me });
  });
});
