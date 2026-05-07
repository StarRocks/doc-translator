# Sample Markdown Document

If you define configuration items in the custom catalog and want configuration items to take effect when you query data, you can add the configuration items to the `PROPERTIES` parameter as key-value pairs when you create an external table. For example, if you define a configuration item `custom-catalog.properties` in the custom catalog, you can run the following command to create an external table.

For example, create an Iceberg external table named `iceberg_tbl` in the database `iceberg_test`.

For example, create a database named `iceberg_test` in StarRocks.

For example, drop a resource named `iceberg0`.

You can modify `hive.metastore.uris` and `iceberg.catalog-impl`of a Iceberg resource in StarRocks 2.3 and later versions. For more information, see [ALTER RESOURCE](../sql-reference/sql-statements/Resource/ALTER_RESOURCE.md).

For example, create a resource named `iceberg1` and set the catalog type to `CUSTOM`.

A custom catalog needs to inherit the abstract class BaseMetastoreCatalog, and you need to implement the IcebergCatalog interface. Additionally, the class name of a custom catalog cannot be duplicated with the name of the class that already exists in StarRock. After the catalog is created, package the catalog and its related files, and place them under the **fe/lib** path of each frontend (FE). Then restart each FE. After you complete the preceding operations, you can create a resource whose catalog is a custom catalog.


| **Parameter**          | **Description**                                              |
| ---------------------- | ------------------------------------------------------------ |
| type                   | The resource type. Set the value to `iceberg`.               |
| iceberg.catalog.type | The catalog type of the resource. Both Hive catalog and custom catalog are supported. If you specify a Hive catalog, set the value to `HIVE`. If you specify a custom catalog, set the value to `CUSTOM`. |
| iceberg.catalog-impl   | The fully qualified class name of the custom catalog. FEs search for the catalog based on this name. If the catalog contains custom configuration items, you must add them to the `PROPERTIES` parameter as key-value pairs when you create an Iceberg external table. |


For example, create a resource named `iceberg0` and set the catalog type to `HIVE`.

* If the metadata of an Iceberg table is obtained from a Hive metastore, you can create a resource and set the catalog type to `HIVE`.

* geo-related query

* Create a Hive resource named `hive0`.

Example: Create the external table `profile_parquet_p7` under the `rawdata` database in the Hive cluster corresponding to the `hive0` resource.

The **esquery function** is used to push down queries **that cannot be expressed in SQL** (such as match and geoshape) to Elasticsearch for filtering. The first parameter in the esquery function is used to associate an index. The second parameter is a JSON expression of basic Query DSL, which is enclosed in brackets {}. **The JSON expression must have but only one root key**, such as match, geo_shape, or bool.

For supported data types and data type mapping between StarRocks and target databases, see [Data type mapping](External_table.md#Data type mapping).

This is a sample markdown document that demonstrates various markdown elements for testing the translation tool.

## Introduction

Welcome to the **Markdown Translator** testing document! This file contains various markdown elements to ensure that translations preserve formatting correctly.

### Features to Test

Here are the key features we want to verify:

1. **Headers** of different levels
2. *Italic* and **bold** text formatting
3. `Inline code` snippets
4. Lists (ordered and unordered)
5. Links and images
6. Code blocks
7. Tables
8. Blockquotes

## Code Examples

Here's a JavaScript function that should remain untranslated:

```javascript
function greetUser(name) {
    console.log(`Hello, ${name}! Welcome to the translator.`);
    return `Greeting sent to ${name}`;
}
```

And here's some Python code:

```python
def calculate_total(items):
    """Calculate the total price of items."""
    total = sum(item['price'] for item in items)
    return total
```

## Lists

### Unordered List

- First item in the list
- Second item with **bold text**
- Third item with [a link](https://example.com)
- Fourth item with `inline code`

### Ordered List

1. Primary step in the process
2. Secondary step with *emphasis*
3. Final step with important details

## Tables

| Feature | Description | Status |
|---------|-------------|--------|
| Translation | Convert text to target language | ✅ Active |
| Formatting | Preserve markdown structure | ✅ Active |
| Code Blocks | Keep code untranslated | ✅ Active |
| Links | Maintain URL integrity | ✅ Active |

## Links and Images

Visit our [documentation](https://github.com/example/markdown-translator) for more information.

![Sample Image](https://via.placeholder.com/300x200?text=Sample+Image)

## Docusaurus admonitions

:::tip
If there are no access keys showing in the MinIO web UI, check the logs of the `minio_mc` service:

```bash
docker compose logs minio_mc
```

Try rerunning the `minio_mc` pod:

```bash
docker compose run minio_mc
```
:::

## Blockquotes

> This is an important quote that should be translated while preserving the blockquote formatting.
> 
> Multiple paragraph quotes should also work correctly.

### Nested Blockquotes

> This is a main quote.
> 
> > This is a nested quote within the main quote.
> > It should maintain proper nesting structure.

## Mixed Content

You can combine `inline code` with **bold text** and *italic text* in the same paragraph. URLs like https://example.com should remain unchanged, as should email addresses like contact@example.com.

## Technical Terms

When dealing with technical documentation, terms like **API**, **JSON**, **HTTP**, and **URL** might need special handling depending on the target language and context.

This sample also intentionally includes several project-specific terms that must NOT be translated: StarRocks, Hive, Leader, Follower, Raft, Docker, Kubernetes, MinIO.

Additional example sentences using common English terms from the Chinese dictionary:

- Data loading is performed during the ingestion phase of the pipeline.
- Data unloading exports results to external systems for downstream processing.
- A native table stores data using the system's internal format.
- Cloud-native table deployments separate storage and compute for scalability.
- An External Table allows querying data that lives outside the database.
- A Hive external table can be used to access legacy Hive datasets.
- Storage layering helps optimize hot and cold data placement.
- The separation of storage and compute enables flexible scaling.
- In shared-data mode, multiple compute clusters access the same storage.
- Zero-migration strategies minimize downtime during upgrades.
- The native vectorized engine accelerates analytical queries.
- Query federation allows joining tables across different systems.
- Columnar storage improves compression and analytical performance.
- Row storage is useful for transactional workloads.
- A materialized view can precompute expensive aggregations.
- Pre-aggregation reduces work at query time by summarizing data ahead of time.
- An aggregate query computes summaries across groups of rows.
- A star schema is a common dimensional modeling pattern for analytics.
- The snowflake schema normalizes dimension tables to reduce redundancy.
- A point query retrieves a single row or a small set of rows by key.

### Code with Explanations

The following command installs the package:

```bash
npm install markdown-translator
```

This command should remain exactly as written, but this explanation text should be translated.

## Conclusion

This sample document tests various markdown elements to ensure the translation tool works correctly. The goal is to translate all readable text while preserving:

- Markdown formatting
- Code blocks and inline code
- URLs and file paths
- Technical syntax

---

*This document was created for testing purposes.* 

# External table

Execute the following statement to create a JDBC resource named `jdbc0`:

When the resource is being created, the FE downloads the JDBC driver JAR package by using the URL that is specified in the `driver_url` parameter, generates a checksum, and uses the checksum to verify the JDBC driver downloaded by BEs.

From 2.5 onwards, StarRocks provides the Data Cache feature, which accelerates hot data queriers on external data sources. For more information, see [Data Cache](data_cache.md).

When BEs query the JDBC external table for the first time and find that the corresponding JDBC driver JAR package does not exist on their machines, BEs download the JDBC driver JAR package by using the URL that is specified in the `driver_url` parameter, and all JDBC driver JAR packages are saved in the `${STARROCKS_HOME}/lib/jdbc_drivers` directory.

> Note: The `ResourceType` column is `jdbc`.

Execute the following statement to delete the JDBC resource named `jdbc0`:

Execute the following statement to create and access a database named `jdbc_test` in StarRocks:

Execute the following statement to create a JDBC external table named `jdbc_tbl` in the database `jdbc_test`:

The required parameters in `properties` are as follows:

Execute the following statement to delete the Hudi resource named `hudi0`:

Execute the following statement to create and open a Hudi database named `hudi_test` in your StarRocks cluster:

The following table describes the parameters.

| Parameter | Description                                                  |
| --------- | ------------------------------------------------------------ |
| ENGINE    | The query engine of the Hudi external table. Set the value to `HUDI`. |
| resource  | The name of the Hudi resource in your StarRocks cluster.     |
| database  | The name of the Hudi database to which the Hudi external table belongs in your StarRocks cluster. |
| table     | The Hudi managed table with which the Hudi external table is associated. |

| Data types supported by Hudi   | Data types supported by StarRocks |
| ----------------------------   | --------------------------------- |
| BOOLEAN                        | BOOLEAN                           |
| INT                            | TINYINT/SMALLINT/INT              |
| DATE                           | DATE                              |
| TimeMillis/TimeMicros          | TIME                              |
| TimestampMillis/TimestampMicros| DATETIME                          |
| LONG                           | BIGINT                            |
| FLOAT                          | FLOAT                             |
| DOUBLE                         | DOUBLE                            |
| STRING                         | CHAR/VARCHAR                      |
| ARRAY                          | ARRAY                             |
| DECIMAL                        | DECIMAL                           |

:::note

StarRocks does not support querying data of the STRUCT or MAP type, nor does it support querying data of the ARRAY type in Merge On Read tables.

:::

> **Note**
>
> StarRocks does not support querying data of the STRUCT or MAP type, nor does it support querying data of the ARRAY type in Merge On Read tables.

:::note

The External Table feature is no longer recommended except for certain corner usage cases, and might be deprecated in future releases. To manage and query data from external data sources in general scenarios, [External Catalog](./catalog/catalog_overview.md) is recommended.

:::

The following table describes the parameters.

| **Parameter**        | **Required** | **Default value** | **Description**                                              |
| -------------------- | ------------ | ----------------- | ------------------------------------------------------------ |
| hosts                | Yes          | None              | The connection address of the Elasticsearch cluster. You can specify one or more addresses. StarRocks can parse the Elasticsearch version and index shard allocation from this address. StarRocks communicates with your Elasticsearch cluster based on the address returned by the `GET /_nodes/http` API operation. Therefore, the value of the `host` parameter must be the same as the address returned by the `GET /_nodes/http` API operation. Otherwise, BEs may not be able to communicate with your Elasticsearch cluster. |
| index                | Yes          | None              | The name of the Elasticsearch index that is created on the table in StarRocks. The name can be an alias. This parameter supports wildcards (\*). For example, if you set `index` to <code class="language-text">hello*</code>, StarRocks retrieves all indexes whose names start with `hello`. |
| user                 | No           | Empty             | The username that is used to log in to the Elasticsearch cluster with basic authentication enabled. Make sure you have access to `/*cluster/state/*nodes/http` and the index. |
| password             | No           | Empty             | The password that is used to log in to the Elasticsearch cluster. |
| type                 | No           | `_doc`            | The type of the index. Default value: `_doc`. If you want to query data in Elasticsearch 8 and later versions, you do not need to configure this parameter because the mapping types have been removed in Elasticsearch 8 and later versions. |
| es.nodes.wan.only    | No           | `false`           | Specifies whether StarRocks only uses the addresses specified by `hosts` to access the Elasticsearch cluster and fetch data.<ul><li>`true`: StarRocks only uses the addresses specified by `hosts` to access the Elasticsearch cluster and fetch data and does not sniff data nodes on which the shards of the Elasticsearch index reside. If StarRocks cannot access the addresses of the data nodes inside the Elasticsearch cluster, you need to set this parameter to `true`.</li><li>`false`: StarRocks uses the addresses specified by `host` to sniff data nodes on which the shards of the Elasticsearch cluster indexes reside. After StarRocks generates a query execution plan, the relevant BEs directly access the data nodes inside the Elasticsearch cluster to fetch data from the shards of indexes. If StarRocks can access the addresses of the data nodes inside the Elasticsearch cluster, we recommend that you retain the default value `false`.</li></ul> |
| es.net.ssl           | No           | `false`           | Specifies whether the HTTPS protocol can be used to access your Elasticsearch cluster. Only StarRocks 2.4 and later versions support configuring this parameter.<ul><li>`true`: Both the HTTPS and HTTP protocols can be used to access your Elasticsearch cluster.</li><li>`false`: Only the HTTP protocol can be used to access your Elasticsearch cluster.</li></ul> |
| enable_docvalue_scan | No           | `true`            | Specifies whether to obtain the values of the target fields from Elasticsearch columnar storage. In most cases, reading data from columnar storage outperforms reading data from row storage. |
| enable_keyword_sniff | No           | `true`            | Specifies whether to sniff TEXT-type fields in Elasticsearch based on KEYWORD-type fields. If this parameter is set to `false`, StarRocks performs matching after tokenization. |

|   SQL syntax  |   ES syntax  |
| :---: | :---: |
|  `=`   |  term query   |
|  `in`   |  terms query   |
|  `>=,  <=, >, <`   |  range   |
|  `and`   |  bool.filter   |
|  `or`   |  bool.should   |
|  `not`   |  bool.must_not   |
|  `not in`   |  bool.must_not + terms   |
|  `esquery`   |  ES Query DSL  |

> Note:
>
> * Currently, the supported Hive storage formats are Parquet, ORC, and CSV.
If the storage format is CSV, quotation marks cannot be used as escape characters.
> * The SNAPPY and LZ4 compression formats are supported.
> * The maximum length of a Hive string column that can be queried is 1 MB. If a string column exceeds 1 MB, it will be processed as a null column.

The first field of `k4` is TEXT, and it will be tokenized by the analyzer configured for `k4` (or by the standard analyzer if no analyzer has been configured for `k4`) after data ingestion. As a result, the first field will be tokenized into three terms: `StarRocks`, `On`, and `Elasticsearch`. The details are as follows:

* **user:** This parameter specifies the username used to access the destination StarRocks cluster.
* **password:** This parameter specifies the password used to access the destination StarRocks cluster.
* **database:** This parameter specifies the database to which the destination table belongs.
* **table:** This parameter specifies the name of the destination table.

~~~SQL
# Create a destination table in the destination StarRocks cluster.
CREATE TABLE t
(
    k1 DATE,
    k2 INT,
    k3 SMALLINT,
    k4 VARCHAR(2048),
    k5 DATETIME
)
ENGINE=olap
DISTRIBUTED BY HASH(k1);

# Create an external table in the source StarRocks cluster.
CREATE EXTERNAL TABLE external_t
(
    k1 DATE,
    k2 INT,
    k3 SMALLINT,
    k4 VARCHAR(2048),
    k5 DATETIME
)
ENGINE=olap
DISTRIBUTED BY HASH(k1)
PROPERTIES
(
    "host" = "127.0.0.1",
    "port" = "9020",
    "user" = "user",
    "password" = "passwd",
    "database" = "db_test",
    "table" = "t"
);

# Write data from a source cluster to a destination cluster by writing data into the StarRocks external table. The second statement is recommended for the production environment.
insert into external_t values ('2020-10-11', 1, 1, 'hello', '2020-10-11 10:00:00');
insert into external_t select * from other_table;
~~~

## References

- [SHOW CREATE TABLE](SHOW_CREATE_TABLE.md)
- [SHOW TABLES](SHOW_TABLES.md)
- [USE](../Database/USE.md)
- [ALTER TABLE](ALTER_TABLE.md)
- [DROP TABLE](DROP_TABLE.md)

