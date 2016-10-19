# humane-indexer

## APIs

>
>Note:
>    * Indexer APIs are available at: `http://<server-url>/:instanceName/indexer/api`.
>    * All types must be valid index types defined in configuration.
>    * BODY must be valid `JSON`.
>    * All requests shall have `Content-Type` header as: `Content-Type: application/json`

### Add

This method adds document of given type.

###### **Method 1**

- TYPE  : `POST`

- URL   : `/add`

- BODY  : `{type: <type>, doc: <data>}`

- SUCCESS RESPONSE  : 

    - Http Status Code: 200 or 201
    
    - Sample Response Body :

      ```
      {
        "_id": "18473",
        "_type": "abcType",
        "_index": "xyzIndex",
        "_version": 5,
        "_statusCode": 201,
        "_status": "SUCCESS",
        "_operation": "ADD",
        "serviceTimeTaken": "127.377"
      }
      ```

- ERROR RESPONSES   : See Common Error Scenarios

    - Case: Document already exists
    
        - Http Status Code: 404
        
        - Sample Response Body :
    
          ```json
          {
            "_id": "18473",
            "_type": "abcType",
            "_index": "xyzIndex",
            "_statusCode": 404,
            "_status": "FAIL",
            "_failCode": "EXISTS_ALREADY",
            "_operation": "ADD",
            "serviceTimeTaken": "70.075"
          }
          ```
    
    - See Common Error Scenarios

###### **Method 2**

- TYPE  : `PUT`

- URL   : `/:type`

- BODY  : `{doc: <data>}`

- SUCCESS RESPONSE  : Same as method 1

- ERROR RESPONSES   : Same as method 1

### Full Update

This method does full update of document of given type and id.

###### **Method 1**

- TYPE  : `POST`

- URL   : `/update`

- BODY  : `{type: <type>, id: <id>, doc: <data>}`

- SUCCESS RESPONSE  :

    - Http Status Code: 200
    
    - Sample Response Body :

      ```
      {
        "_id": "18473",
        "_type": "abcType",
        "_index": "xyzIndex",
        "_version": 1,
        "_statusCode": 200,
        "_status": "SUCCESS",
        "_operation": "UPDATE",
        "serviceTimeTaken": "255.350"
      }
      ```

- ERROR RESPONSES   :

    - Case: Not found ID
    
        - Http Status Code: 404
        
        - Sample Response Body :
    
          ```json
          {
            "_id": "18473",
            "_type": "abcType",
            "_index": "xyzIndex",
            "_statusCode": 404,
            "_status": "FAIL",
            "_failCode": "NOT_FOUND",
            "_operation": "UPDATE",
            "serviceTimeTaken": "70.075"
          }
          ```
    
    - See Common Error Scenarios
  
###### **Method 2**

- TYPE  : `POST`

- URL   : `/:type/:id`

- BODY  : `{doc: <data>}`

- SUCCESS RESPONSE  : Same as method 1

- ERROR RESPONSES   : Same as method 1

### Merge

This method merges given data with existing data of given type and id.

- TYPE  : `POST`

- URL   : `/merge`

- BODY  : `{type: <type>, id: <id>, doc: <data>}`

- SUCCESS RESPONSE  :

    - Http Status Code: 200
    
    - Sample Response Body :

      ```
      {
        "_id": "18473",
        "_type": "abcType",
        "_index": "xyzIndex",
        "_version": 1,
        "_statusCode": 200,
        "_status": "SUCCESS",
        "_operation": "PARTIAL_UPDATE",
        "serviceTimeTaken": "133.818"
      }
      ```

- ERROR RESPONSES   :

    - Case: Not found ID
    
        - Http Status Code: 404
        
        - Sample Response Body :
    
          ```json
          {
            "_id": "18479",
            "_type": "abcType",
            "_index": "xyzIndex",
            "_statusCode": 404,
            "_status": "FAIL",
            "_failCode": "NOT_FOUND",
            "_operation": "MERGE",
            "serviceTimeTaken": "16.548"
          }
          ```
    
    - See Common Error Scenarios

### Upsert

This method adds data of given type if it does not exist, else makes full update.

###### **Method 1**

- TYPE  : `POST`

- URL   : `/upsert`

- BODY  : `{type: <type>, doc: <data>}`

- SUCCESS RESPONSE  : For new document: add response, for existing document: update response

- ERROR RESPONSES   : See Common Error Scenarios

###### **Method 2**

- TYPE  : `POST`

- URL   : `/:type`

- BODY  : `{doc: <data>}`

- SUCCESS RESPONSE  : Same as method 1

- ERROR RESPONSES   : Same as method 1

### Remove

This method removes document of given type and id.

###### **Method 1**

- TYPE  : `POST`

- URL   : `/remove`

- BODY  : `{type: <type>, id: <id>}`

- SUCCESS RESPONSE  :

    - Http Status Code: 200
    
    - Sample Response Body :
    
      ```
      {
        "_id": "18473",
        "_type": "abcType",
        "_index": "xyzIndex",
        "_version": 4,
        "found": true,
        "_statusCode": 200,
        "_status": "SUCCESS",
        "_operation": "REMOVE",
        "serviceTimeTaken": "122.236"
      }
      ```

- ERROR RESPONSES   :
  
    - Case: Not found ID
    
        - Http Status Code: 404
        
        - Sample Response Body :
    
          ```json
          {
            "_id": "18473",
            "_type": "abcType",
            "_index": "xyzIndex",
            "_statusCode": 404,
            "_status": "FAIL",
            "_operation": "REMOVE",
            "_failCode": "NOT_FOUND",
            "serviceTimeTaken": "84.184"
          }
          ```
    
    - See Common Error Scenarios
    
###### **Method 2**

- Type  : `DELETE`

- URL   : `/:type/:id`

- SUCCESS RESPONSE  : Same as method 1

- ERROR RESPONSES   : Same as method 1

### Common Error Scenarios

- Case: Undefined Type - when type is not specified
    - Http Status Code: 400
    
    - Sample Response Body :
    
      ```json
      {
        "_statusCode": 400,
        "_errorCode": "VALIDATION_ERROR",
        "_status": "ERROR",
        "details": {
          "code": "UNDEFINED_TYPE"
        },
        "_errorId": 1458790949474
      }
      ```

- Case: Unrecognized Type - when type is not among the configured

    - Http Status Code: 400
    
    - Sample Response Body :
    
      ```json
      {
        "_statusCode": 400,
        "_errorCode": "VALIDATION_ERROR",
        "_status": "ERROR",
        "details": {
          "code": "UNRECOGNIZED_TYPE",
          "type": "XYZ"
        },
        "_errorId": 1458790974877
      }
      ```
         
- Case: Undefined ID - when ID is not specified or can not be calculated

    - Http Status Code: 400
    
    - Sample Response Body :
    
      ```json
      {
        "_statusCode": 400,
        "_errorCode": "VALIDATION_ERROR",
        "_status": "ERROR",
        "details": {
          "code": "UNDEFINED_ID"
        },
        "_errorId": 1458748607506
      }
      ```
  
- Case: Internal Service Error - when there is some internal service error

    - Http Status Code: 500
    
    - Sample Response Body :
    
      ```json
      {
        "_statusCode": 500,
        "_errorCode": "INTERNAL_SERVICE_ERROR",
        "_status": "ERROR",
        "_errorId": 1458819775194
      }
      ```
