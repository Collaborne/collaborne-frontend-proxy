# collaborne-frontend-proxy [![Build Status](https://travis-ci.org/Collaborne/collaborne-frontend-proxy.svg?branch=master)](https://travis-ci.org/Collaborne/collaborne-frontend-proxy) [![Greenkeeper badge](https://badges.greenkeeper.io/Collaborne/collaborne-frontend-proxy.svg)](https://greenkeeper.io/)

This is a simple proxy for static websites hosted on S3, which is aware of a directory structure: instead of having one bucket for each application + version, it manages applications and versions as prefixes in S3, so application 'foo' with version '38271ad' would be searched for in the bucket under prefix `foo/38271ad`, and would be accessible under `CFP-URL/app/foo/38271ad`.

CFP supports marking a version as 'current', and it tracks whichever version was 'current' before as 'previous': `CFP-URL/app/foo/current` would open the current version, and `CFP-URL/app/foo/previous` would open the previous one. Additionally CFP tracks the latest created version as 'latest'.

CFP authorizes uses via GitHub: each user that is allowed to use the UI needs to be registered with their GitHub id in the `users` table. The applications themselves are not protected, so the links are shareable easily with designers and other stakeholders.

## Running

This project assumes various environment variables to be set in order to work:

| Variable              | Description                                                 |
| --------------------- | ----------------------------------------------------------- |
| DATABASE_URL          | URL to a Postgres (9.1+) database with `tables.sql` loaded. |
| CFP_AWS_BUCKET        | Name of the bucket in S3                                    |
| CFP_JWT_KEY           | Key for signing the JWTs, should be random enough.          |
| AWS_ACCESS_KEY_ID     | AWS SDK Access Key Id                                       |
| AWS_SECRET_ACCESS_KEY | AWS SDK Secret Access Key                                   |
| GH_CLIENT_ID          | Client ID for the GitHub integration                        |
| GH_CLIENT_SECRET      | Client secret for the GitHub integration                    |
| GH_WEBHOOK_SECRET     | Secret used for signing webhook events                      |
| SLACK_CLIENT_ID       | Client ID for the Slack integration                         |
| SLACK_CLIENT_SECRET   | Client secret for the Slack integration                     |

The easiest way to get CFP running is to use Heroku with their Postgres add-on.

## License

    This software is licensed under the Apache 2 license, quoted below.

    Copyright 2016-2017 Collaborne B.V. <http://github.com/Collaborne/>

    Licensed under the Apache License, Version 2.0 (the "License"); you may not
    use this file except in compliance with the License. You may obtain a copy of
    the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
    WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
    License for the specific language governing permissions and limitations under
    the License.

