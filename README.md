# collaborne-frontend-proxy [![Build Status](https://travis-ci.org/Collaborne/collaborne-frontend-proxy.svg?branch=master)](https://travis-ci.org/Collaborne/collaborne-frontend-proxy)

## Running

This project assumes various environment variables to be set in order to work:

| Variable              | Description                                        |
| --------------------- | -------------------------------------------------- |
| CFP_AWS_BUCKET        | Name of the bucket in S3                           |
| CFP_JWT_KEY           | Key for signing the JWTs, should be random enough. |
| AWS_ACCESS_KEY_ID     | AWS SDK Access Key Id                              |
| AWS_SECRET_ACCESS_KEY | AWS SDK Secret Access Key                          |
| GH_CLIENT_ID          | Client ID for the GitHub integration               |
| GH_CLIENT_SECRET      | Client secret for the GitHub integration           |
| GH_WEBHOOK_SECRET     | Secret used for signing webhook events             |


## License

    This software is licensed under the Apache 2 license, quoted below.

    Copyright 2016 Collaborne B.V. <http://github.com/Collaborne/>

    Licensed under the Apache License, Version 2.0 (the "License"); you may not
    use this file except in compliance with the License. You may obtain a copy of
    the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
    WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
    License for the specific language governing permissions and limitations under
    the License.

